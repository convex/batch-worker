import type { Value } from "convex/values";
import { internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "./functions.js";
import {
  type Config,
  DEFAULT_CONFIG,
  MONITOR_REFRESH_WITHIN_MS,
  RUNNING_THRESHOLD_MS,
  MONITOR_LAG_MS,
  type WorkpoolConfig,
} from "./shared.js";
import { cancelWorkpoolJob, enqueueLoop } from "./workpool.js";

export async function getWorker(ctx: QueryCtx, name: string) {
  return ctx.db
    .query("workers")
    .withIndex("name", (q) => q.eq("name", name))
    .unique();
}

export async function getOrCreateWorkerState(
  ctx: MutationCtx,
  worker: Doc<"workers">,
) {
  const state = await ctx.db.get("workerState", worker.stateId);
  if (state) return state;
  worker.stateId = await ctx.db.insert("workerState", {
    generation: 0n,
    lastWorkTs: 0,
  });
  await ctx.db.patch("workers", worker._id, { stateId: worker.stateId });
  return (await ctx.db.get("workerState", worker.stateId))!;
}

// ── Public entry points (ping / start / stop) ──────────────────────────────

/**
 * Register-or-refresh a worker and make sure it's running. Carries the work
 * query/mutation + config; creates the worker on first call. Call it right
 * after inserting work.
 *
 * Cheap and OCC-friendly: when the loop is already running it only reads the
 * `workers` doc and returns.
 */
export async function ping(
  ctx: MutationCtx,
  args: {
    name: string;
    workQuery: string;
    workerMutation: string;
    config?: Partial<Config> | undefined;
    workpool?: WorkpoolConfig | undefined;
  },
): Promise<void> {
  const worker = await getWorker(ctx, args.name);

  if (!worker) {
    const stateId = await ctx.db.insert("workerState", {
      generation: 0n,
      lastWorkTs: 0,
    });
    const workerId = await ctx.db.insert("workers", {
      name: args.name,
      workQuery: args.workQuery,
      workerMutation: args.workerMutation,
      config: args.config ?? {},
      ...(args.workpool ? { workpool: args.workpool } : {}),
      status: { kind: "running" },
      stateId,
    });
    const delayMs = args.config?.debounceMs ?? DEFAULT_CONFIG.debounceMs;
    const worker = (await ctx.db.get("workers", workerId))!;
    await scheduleLoopRun(ctx, worker, { delayMs });
    return;
  }

  const poolChanged = !sameWorkpool(worker.workpool, args.workpool);
  if (
    poolChanged ||
    args.workQuery !== worker.workQuery ||
    args.workerMutation !== worker.workerMutation ||
    (args.config &&
      (args.config.debounceMs !== worker.config.debounceMs ||
        args.config.monitorLagMs !== worker.config.monitorLagMs))
  ) {
    worker.workQuery = args.workQuery;
    worker.workerMutation = args.workerMutation;
    if (args.workpool) worker.workpool = args.workpool;
    else delete worker.workpool;
    if (args.config) {
      worker.config = args.config;
    }
    await ctx.db.replace("workers", worker._id, worker);
  }
  if (poolChanged) {
    const state = await getOrCreateWorkerState(ctx, worker);
    const scheduled =
      state.runnerId &&
      (await ctx.db.system.get("_scheduled_functions", state.runnerId));
    const runAt =
      state.workpoolJob?.runAt ?? scheduled?.scheduledTime ?? Date.now();
    await cancelLoop(ctx, state);
    await cancelMonitor(ctx, state);
    if (
      worker.status.kind !== "stopped" &&
      (state.runnerId || state.workpoolJob || worker.status.kind === "running")
    ) {
      // Preserve debounce/timeout eligibility while moving an active worker.
      // An idle worker's ping below may still interrupt its wait.
      await scheduleLoopRun(ctx, worker, {
        delayMs: Math.max(0, runAt - Date.now()),
      });
    }
  }
  if (worker.status.kind !== "idle") {
    ctx.log.debug(`[ping] "${worker.name}" ${worker.status.kind} — no-op`);
    return;
  }
  await wake(ctx, worker);
}

function sameWorkpool(a?: WorkpoolConfig, b?: WorkpoolConfig): boolean {
  return (
    a?.enqueue === b?.enqueue &&
    a?.cancel === b?.cancel &&
    a?.maxParallelism === b?.maxParallelism &&
    a?.logLevel === b?.logLevel
  );
}

/**
 * Resume an existing worker (e.g. after `stop`) using its stored handles and
 * config. No-ops if the worker was never created with `ping`.
 */
export async function start(ctx: MutationCtx, name: string): Promise<void> {
  const worker = await getWorker(ctx, name);
  if (!worker) return;
  const status = worker.status;
  if (status.kind !== "stopped") {
    ctx.log.debug(`[start] "${worker.name}" ${status.kind} — no-op`);
    return;
  }
  await wake(ctx, worker);
}

/**
 * Manual recovery: cancel whatever is scheduled and start a fresh loop run
 * and monitor, from any status (including stopped). Use when the worker is
 * wedged, e.g. after its scheduled functions were canceled from the dashboard
 * or the monitor itself died, leaving status "running" so pings no-op.
 */
export async function kick(ctx: MutationCtx, name: string): Promise<void> {
  const worker = await getWorker(ctx, name);
  if (!worker) return;
  const state = await getOrCreateWorkerState(ctx, worker);
  await cancelLoop(ctx, state);
  // Clear the monitor state so scheduleLoopRun arms a fresh monitor even if
  // monitorRunAtMs still looks healthy.
  await cancelMonitor(ctx, state);
  await ctx.db.patch("workers", worker._id, { status: { kind: "running" } });
  await scheduleLoopRun(ctx, worker, { delayMs: 0 });
}

/**
 * Stop the worker: cancel its loop and monitor and mark it stopped.
 * Only `start` will resume it.
 */
export async function stop(ctx: MutationCtx, name: string): Promise<void> {
  const worker = await getWorker(ctx, name);
  if (!worker) return;
  const state = await getOrCreateWorkerState(ctx, worker);
  await cancelLoop(ctx, state);
  await cancelMonitor(ctx, state);
  await ctx.db.patch("workers", worker._id, { status: { kind: "stopped" } });
}

// ── Waking the loop ────────────────────────────────────────────────────────

/**
 * Wake a worker on ping/start: mark it running and make sure a loop run is
 * scheduled within the debounce window. If one already is, keep it (canceling
 * would only delay work); otherwise cancel and reschedule for `now +
 * debounceMs`.
 */
async function wake(ctx: MutationCtx, worker: Doc<"workers">): Promise<void> {
  const state = await getOrCreateWorkerState(ctx, worker);
  const now = Date.now();
  const loop =
    state.runnerId &&
    (await ctx.db.system.get("_scheduled_functions", state.runnerId));
  const runAt =
    state.workpoolJob?.runAt ??
    (loop?.state.kind === "pending" ? loop.scheduledTime : undefined);
  // Possibly wait for a debounce window before running
  const delayMs = worker.config.debounceMs ?? DEFAULT_CONFIG.debounceMs;
  await ctx.db.patch("workers", worker._id, { status: { kind: "running" } });
  // Rescheduling would run at `now + delayMs`; if the pending run is already
  // sooner than that (or imminent), canceling it would only delay work.
  if (
    runAt !== undefined &&
    runAt < now + Math.max(delayMs, RUNNING_THRESHOLD_MS)
  ) {
    ctx.log.debug(
      `[wake] "${worker.name}" already scheduled to run sooner — keeping it`,
    );
    // The kept run gets a fresh cooldown window too.
    await ctx.db.patch("workerState", state._id, {
      lastWorkTs: Math.max(state.lastWorkTs, runAt),
    });
    return;
  }
  ctx.log.debug(`[wake] "${worker.name}" interrupting wait`);
  if (state.runnerId || state.workpoolJob) await cancelLoop(ctx, state);
  await scheduleLoopRun(ctx, worker, { delayMs, lastWorkTs: now + delayMs });
}

// ── Scheduling the loop ────────────────────────────────────────────────────

/** Re-run the loop after `delayMs`, staying in the running state. */
export async function continueRunning(
  ctx: MutationCtx,
  worker: Doc<"workers">,
  delayMs: number,
  opts?: { lastWorkTs?: number | undefined; cursor?: Value | undefined },
): Promise<void> {
  let lastWorkTs = opts?.lastWorkTs;
  if (worker.status.kind !== "running") {
    await ctx.db.patch("workers", worker._id, { status: { kind: "running" } });
    // Entering running starts a fresh cooldown window.
    lastWorkTs = Math.max(lastWorkTs ?? 0, Date.now() + delayMs);
  }
  await scheduleLoopRun(ctx, worker, {
    delayMs,
    lastWorkTs,
    cursor: opts?.cursor,
  });
}

/**
 * Sleep until `now + timeoutMs`, ignoring pings until `now + debounceMs` and
 * letting them interrupt afterward.
 */
export async function scheduleWaiting(
  ctx: MutationCtx,
  worker: Doc<"workers">,
  timeoutMs: number,
  lastWorkTs?: number,
): Promise<void> {
  await scheduleLoopRun(ctx, worker, {
    delayMs: timeoutMs,
    lastWorkTs,
  });
  await ctx.db.patch("workers", worker._id, { status: { kind: "idle" } });
}

/** Stop looping: mark idle and cancel the monitor. */
export async function goIdle(
  ctx: MutationCtx,
  worker: Doc<"workers">,
  state: Doc<"workerState">,
): Promise<void> {
  await ctx.db.patch("workerState", state._id, {
    generation: state.generation + 1n,
    runnerId: undefined,
    workpoolJob: undefined,
  });
  await cancelMonitor(ctx, state);
  await ctx.db.patch("workers", worker._id, { status: { kind: "idle" } });
}

async function scheduleLoopRun(
  ctx: MutationCtx,
  worker: Doc<"workers">,
  opts: {
    delayMs: number;
    lastWorkTs?: number | undefined;
    cursor?: Value | undefined;
  },
): Promise<void> {
  const state = await getOrCreateWorkerState(ctx, worker);
  const generation = state.generation + 1n;
  const runAt = Date.now() + opts.delayMs;
  let runnerId: Id<"_scheduled_functions"> | undefined;
  let workpoolJob: Doc<"workerState">["workpoolJob"];
  if (worker.workpool) {
    const id = await enqueueLoop(
      ctx,
      worker.workpool,
      { name: worker.name, generation },
      runAt,
    );
    workpoolJob = { id, runAt, cancel: worker.workpool.cancel };
  } else {
    runnerId = await ctx.scheduler.runAfter(opts.delayMs, internal.loop.loop, {
      name: worker.name,
      generation,
    });
  }
  // The cursor rides along on the patch this already does every iteration.
  // `undefined` leaves the stored cursor as it was.
  await ctx.db.patch("workerState", state._id, {
    generation,
    runnerId,
    workpoolJob,
    ...(opts.lastWorkTs !== undefined ? { lastWorkTs: opts.lastWorkTs } : {}),
    ...(opts.cursor !== undefined ? { cursor: opts.cursor } : {}),
  });

  if (!worker.workpool) await ensureMonitored(ctx, worker, runAt);
}

/** Invalidation is transactional even if Workpool already admitted the job. */
async function cancelLoop(
  ctx: MutationCtx,
  state: Doc<"workerState">,
): Promise<void> {
  if (state.runnerId) await cancelIfPending(ctx, state.runnerId);
  if (state.workpoolJob) await cancelWorkpoolJob(ctx, state.workpoolJob);
  await ctx.db.patch("workerState", state._id, {
    runnerId: undefined,
    workpoolJob: undefined,
    generation: state.generation + 1n,
  });
}

// ── Monitor ────────────────────────────────────────────────────────────────

/**
 * Keep the monitor scheduled ~`monitorLagMs` after the loop's next run. Only
 * reschedules when the monitor is missing or about to fire, so a healthy
 * fast-looping worker pushes it back roughly once a minute rather than every
 * iteration.
 */
export async function ensureMonitored(
  ctx: MutationCtx,
  worker: Doc<"workers">,
  loopRunAtMs: number,
): Promise<void> {
  if (worker.workpool) return;
  const state = await ctx.db.get("workerState", worker.stateId);
  if (!state) return;

  const lag = Math.max(
    MONITOR_REFRESH_WITHIN_MS,
    worker.config.monitorLagMs ?? MONITOR_LAG_MS,
  );

  const now = Date.now();
  // If the monitor lag is short, just use half of it.
  const gracePeriod = Math.min(lag / 2, MONITOR_REFRESH_WITHIN_MS);
  const close =
    state.monitorRunAtMs == null || state.monitorRunAtMs <= now + gracePeriod;
  if (state.monitorId && !close) return;

  if (state.monitorId) await cancelIfPending(ctx, state.monitorId);
  // Clamp to the future in case loopRunAtMs is stale (e.g. a stuck runner's
  // scheduledTime).
  const desiredAt = Math.max(loopRunAtMs, now) + lag;
  const monitorId = await ctx.scheduler.runAt(
    desiredAt,
    internal.monitor.monitor,
    { name: worker.name },
  );
  await ctx.db.patch("workerState", worker.stateId, {
    monitorId,
    monitorRunAtMs: desiredAt,
  });
}

export async function cancelMonitor(
  ctx: MutationCtx,
  state: Doc<"workerState">,
): Promise<void> {
  if (state.monitorId) await cancelIfPending(ctx, state.monitorId);
  if (state.monitorId || state.monitorRunAtMs != null) {
    await ctx.db.patch("workerState", state._id, {
      monitorId: undefined,
      monitorRunAtMs: undefined,
    });
  }
}

async function cancelIfPending(
  ctx: MutationCtx,
  id: Id<"_scheduled_functions">,
): Promise<void> {
  const fn = await ctx.db.system.get("_scheduled_functions", id);
  if (fn && fn.state.kind === "pending") {
    await ctx.scheduler.cancel(id);
  }
}
