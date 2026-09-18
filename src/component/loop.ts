import { v, type Value } from "convex/values";
import type { FunctionHandle } from "convex/server";
import { internalMutation, type MutationCtx } from "./functions.js";
import {
  continueRunning,
  getWorker,
  getOrCreateWorkerState,
  goIdle,
  scheduleWaiting,
} from "./kick.js";
import {
  RUNNING_THRESHOLD_MS,
  type BatchQueryArgs,
  type BatchResult,
  type WorkerResult,
} from "./shared.js";

const DEFAULT_POLL_INTERVAL_MS = 200;
const DEFAULT_COOLDOWN_MS = 2000;

/**
 * The worker's main loop. At most one is scheduled/running per worker, enforced
 * by the `generation` check: a stale scheduled loop (superseded by a newer
 * (re)start or the monitor) exits silently.
 *
 * Each iteration runs the work query as a *snapshot* read (no OCC dependency),
 * runs the worker mutation if there's a batch, then reschedules itself:
 *  - more work / no result hint → run again immediately,
 *  - mutation returned debounce/timeout → wait (interruptible) accordingly,
 *  - query reported idle with a timeout → sleep until then,
 *  - query idle within cooldown → poll,
 *  - cooldown elapsed → confirm with a real (dependency) read, then go idle.
 */
export const loop = internalMutation({
  args: { name: v.string(), generation: v.int64() },
  handler: async (ctx, { name, generation }) => {
    const worker = await getWorker(ctx, name);
    const state = worker && (await getOrCreateWorkerState(ctx, worker));
    if (!worker || !state) {
      ctx.log.debug(`[loop] "${name}" worker not found or state missing`);
      return; // worker was deleted
    }

    if (state.generation !== generation) {
      ctx.log.debug(
        `[loop] "${name}" superseded (gen ${generation} !== ${state.generation})`,
      );
      return;
    }

    const now = Date.now();
    // The cursor is sent once a batch has returned one.
    const queryArgs: BatchQueryArgs<Value> = {
      name,
      ...(state.cursor !== undefined ? { cursor: state.cursor } : {}),
    };
    const queryRef = worker.workQuery as unknown as FunctionHandle<
      "query",
      BatchQueryArgs<Value>,
      BatchResult<Value, Value>
    >;

    // Stale snapshot read: no OCC dependency, so concurrent inserts while we
    // drain don't force this loop to retry. The query's snapshot may be older
    // than the worker mutation's, but includes this worker's committed writes
    // from previous rounds. Revalidate rows when processing depends on changes
    // by other writers. If the query or worker mutation throws, this loop fails
    // (and doesn't reschedule) — the monitor restarts it.
    const result = await ctx.runQuery(queryRef, queryArgs, {
      useStaleSnapshot: true,
    });

    // ── There's work: run the worker mutation, then reschedule. ──
    if (result && "batch" in result) {
      const mutationRef = worker.workerMutation as unknown as FunctionHandle<
        "mutation",
        any,
        WorkerResult<Value>
      >;
      const ret = await ctx.runMutation(mutationRef, result.batch);
      const debounceMs = ret?.debounceMs ?? 0;
      // The mutation shares this transaction, so the cursor commits with the
      // batch. A cursor from the mutation wins over the query's: it knows how
      // far the work actually got.
      const cursor = ret?.cursor !== undefined ? ret.cursor : result.cursor;
      await continueRunning(ctx, worker, debounceMs, {
        lastWorkTs: now,
        cursor,
      });
      return;
    }

    // —— No work - before going idle or setting a timeout, cool down. ——
    const pollIntervalMs = result.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    if (now < state.lastWorkTs + (result.cooldownMs ?? DEFAULT_COOLDOWN_MS)) {
      await continueRunning(ctx, worker, pollIntervalMs);
      return;
    }

    // ── Just in case the "real" query shows work. ——
    // This is to capture races in going to idle just after a racing ping.
    if (await confirmHasWork(ctx, queryRef, queryArgs)) {
      ctx.log.warn(`[loop] ${worker.name} snapshot query mismatch`);
      await continueRunning(ctx, worker, 0);
      return;
    }

    // ── The query told us when to try again. ──
    const idleTimeoutMs =
      result?.kind === "idle" ? result.timeoutMs : undefined;
    if (idleTimeoutMs != null) {
      if (
        idleTimeoutMs <= RUNNING_THRESHOLD_MS ||
        idleTimeoutMs <= pollIntervalMs
      ) {
        // May as well stay running.
        await continueRunning(ctx, worker, idleTimeoutMs);
      } else {
        // debounce 0: a ping can interrupt the sleep at any time.
        await scheduleWaiting(ctx, worker, idleTimeoutMs);
      }
      return;
    }

    // ── No work and no time to retry, so go fully idle. ──
    await goIdle(ctx, worker, state);
    ctx.log.debug(`[loop] "${name}" → idle`);
  },
});

/** A real (dependency-taking) read of the work query. */
async function confirmHasWork(
  ctx: MutationCtx,
  queryRef: FunctionHandle<
    "query",
    BatchQueryArgs<Value>,
    BatchResult<Value, Value>
  >,
  queryArgs: BatchQueryArgs<Value>,
): Promise<boolean> {
  const confirm = await ctx.runQuery(queryRef, queryArgs);
  // Match the snapshot path's detection: a result with a `batch` is work.
  return !!confirm && "batch" in confirm;
}
