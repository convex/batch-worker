import {
  asObjectValidator,
  v,
  type Infer,
  type PropertyValidators,
  type VCommitTs,
  type Validator,
} from "convex/values";

export const MS = 1;
export const SECOND = 1000 * MS;
export const MINUTE = 60 * SECOND;

// Delays at or below this are treated as the loop being "running" (a ping is a
// no-op — the work will be picked up imminently). Longer delays put the loop in
// a "waiting" state that a ping can interrupt. Also the boundary between the
// short cooldown poll and a long sleep.
export const RUNNING_THRESHOLD_MS = 1 * SECOND;
// The monitor is scheduled this long after the loop's next run, so it only
// fires if the loop fails to run (and reschedule the monitor) on time.
export const MONITOR_LAG_MS = 60 * SECOND;
// Refresh the monitor when it would otherwise fire within this window — keeps
// it trailing the loop without rescheduling on every iteration.
export const MONITOR_REFRESH_WITHIN_MS = 10 * SECOND;
// How far past its scheduledTime a pending loop run may be before it's
// presumed stuck rather than delayed by scheduler backlog.
export const STUCK_RUNNER_GRACE_MS = 60 * SECOND;

/**
 * Configuration for a worker's main loop.
 */
export const vConfig = v.object({
  /**
   * How long the loop waits before its first batch after being started from
   * idle. Lets a burst of inserts accumulate so they're processed together.
   */
  debounceMs: v.number(),
  /**
   * How long after the loop's scheduled run the monitor is scheduled. The
   * monitor restarts the loop if it didn't run (and push the monitor back) by
   * then — this is also the effective retry cadence when the work query or
   * worker mutation throws.
   */
  monitorLagMs: v.number(),
});
export type Config = Infer<typeof vConfig>;

export const DEFAULT_CONFIG: Config = {
  debounceMs: 0,
  monitorLagMs: MONITOR_LAG_MS,
};

/**
 * The run state of a worker, on the `workers` doc. Written only on transitions
 * (and the occasional monitor refresh), so `ping`/`start` can read it on every
 * insert without OCC-conflicting with the fast-looping loop.
 *
 * - `idle`: no loop is scheduled, or it's sleeping on a timeout. `ping` wakes.
 * - `running`: loop is executing or scheduled to run soon.  `ping` no-ops.
 */
export const vStatus = v.union(
  v.object({ kind: v.literal("idle") }),
  v.object({ kind: v.literal("running") }),
  v.object({ kind: v.literal("stopped") }),
);
export type Status = Infer<typeof vStatus>;

// ── The work query / worker mutation contract ──────────────────────────────

/**
 * The default cursor type: a commit timestamp, as written by
 * `ctx.db.vars.commitTs` and read back as a `bigint`.
 */
export const vDefaultCursor = v.commitTs();
export type DefaultCursor = Infer<typeof vDefaultCursor>;

/**
 * The args your work query receives: the worker's `name` (so a single query
 * function can serve multiple named queues) and the `cursor` this worker last
 * committed, if any.
 *
 * @deprecated Use {@link defineBatchWorkerValidators} to obtain all four
 * argument and return validators, so the batch shape and the cursor type match
 * between the query and the mutation.
 */
export const vBatchQueryArgs = v.object({
  name: v.string(),
  cursor: v.optional(vDefaultCursor),
});
export type BatchQueryArgs<Cursor = DefaultCursor> = {
  name: string;
  cursor?: Cursor;
};

/**
 * What your work query returns: either a batch of work to process, or an
 * explicit `idle` (optionally with a `timeoutMs` hint for when to check again
 * — e.g. when the next item is scheduled).
 *
 * The query may read an older snapshot than the worker mutation, but each round
 * sees this worker's committed writes from previous rounds. Re-fetch by ID when
 * processing depends on changes by other writers. Values can be passed through
 * when they cannot change before processing or older values are acceptable.
 *
 * Alongside a batch, return a `cursor` saying how far this batch got. The
 * component commits it with the batch, and hands it back as `args.cursor` on
 * the next call so the scan resumes there. It is committed only if the worker
 * mutation commits.
 *
 * `idle` ends the loop until a ping wakes it, so it carries no cursor. To skip
 * past a stretch you scanned and found nothing to do in, return `work` with an
 * empty batch and the advanced cursor.
 */
function vBatchResultFor<
  B extends Validator<any, "required", any> | PropertyValidators,
  C extends Validator<any, "required", any>,
>(batch: B, cursor: C) {
  return v.union(
    v.object({
      kind: v.optional(v.literal("work")),
      batch: asObjectValidator(batch),
      cursor: v.optional(cursor),
    }),
    v.object({
      kind: v.literal("idle"),
      /**
       * How long the loop keeps polling an idle queue before going fully idle.
       * Helps avoid unnecessary workers state write conflicts.
       */
      cooldownMs: v.optional(v.number()),
      /**
       * How long to wait between running the query again while cooling down.
       */
      pollIntervalMs: v.optional(v.number()),
      /**
       * Once cooled down, run again by this long from now at the latest. A ping
       * interrupts and runs sooner. If omitted, the loop goes fully idle and
       * only a ping/start wakes it.
       */
      timeoutMs: v.optional(v.number()),
    }),
  );
}

/**
 * Builds the validator for what your work query returns: a batch with an
 * optional commit-timestamp `cursor`, or `idle`.
 *
 * @deprecated Use {@link defineBatchWorkerValidators} to obtain all four
 * argument and return validators, so the batch shape and the cursor type match
 * between the query and the mutation.
 */
export function vBatchResult<
  B extends Validator<any, "required", any> | PropertyValidators,
>(batch: B) {
  return vBatchResultFor(batch, vDefaultCursor);
}

/**
 * What a work query returns: a `batch` of work to process, or `idle` with an
 * optional `timeoutMs` hint for when to look again.
 *
 * @typeParam Batch - the shape passed to your worker mutation.
 */
export type BatchResult<Batch, Cursor = DefaultCursor> =
  | {
      kind?: "work";
      batch: Batch;
      /**
       * How far this batch got. Committed with the batch and passed to the
       * next query call as `args.cursor`. Omit to leave the cursor untouched.
       */
      cursor?: Cursor;
    }
  | {
      kind: "idle";
      /**
       * How long the loop keeps polling an idle queue before going fully idle.
       * Helps avoid unnecessary workers state write conflicts.
       */
      cooldownMs?: number;
      /**
       * How long to wait between running again while cooling down.
       */
      pollIntervalMs?: number;
      /**
       * The maximum time it should go idle for when no pings occur.
       */
      timeoutMs?: number;
    };

/**
 * What a worker mutation may return to steer the loop. Returning nothing (or
 * null) re-runs immediately (drain as fast as possible).
 */
function vWorkerResultFor<C extends Validator<any, "required", any>>(
  cursor: C,
) {
  return v.union(
    v.null(),
    v.object({
      /**
       * Don't run again — and ignore pings — for at least this long. Use to
       * debounce / batch.
       */
      debounceMs: v.optional(v.number()),
      /**
       * Overrides the cursor the work query returned. Return one when the batch
       * made partial progress and you can derive how far it got, e.g. from a
       * per-item timestamp carried in the batch.
       */
      cursor: v.optional(cursor),
    }),
  );
}

/**
 * What a worker mutation may return to steer the loop.
 *
 * @deprecated Use {@link defineBatchWorkerValidators} to obtain all four
 * argument and return validators, so the batch shape and the cursor type match
 * between the query and the mutation.
 */
export const vWorkerResult = vWorkerResultFor(vDefaultCursor);
export type WorkerResult<Cursor = DefaultCursor> = null | {
  debounceMs?: number;
  cursor?: Cursor;
};

/**
 * Builds all four of a worker's argument and return validators from a single
 * declaration, so the batch shape and the cursor type match between the work
 * query and the worker mutation.
 *
 * `cursor` defaults to a commit timestamp ({@link vDefaultCursor}); pass one to
 * key the worker on something else, like a `paginator` cursor.
 *
 * @example
 * ```ts
 * const { vQueryArgs, vQueryReturns, vMutationArgs, vMutationReturns } =
 *   defineBatchWorkerValidators({
 *     batch: { ids: v.array(v.id("tasks")) },
 *     cursor: v.string(), // optional; defaults to v.commitTs()
 *   });
 *
 * export const getBatch = internalQuery({
 *   args: vQueryArgs,
 *   returns: vQueryReturns,
 *   handler: async (ctx, { cursor }) => ...,
 * });
 *
 * export const processBatch = internalMutation({
 *   args: vMutationArgs,
 *   returns: vMutationReturns,
 *   handler: async (ctx, { ids }) => ...,
 * });
 * ```
 */
export function defineBatchWorkerValidators<
  B extends Validator<any, "required", any> | PropertyValidators,
  C extends Validator<any, "required", any> = VCommitTs,
>(spec: { batch: B; cursor?: C }) {
  const cursor = (spec.cursor ?? vDefaultCursor) as C;
  return {
    /** Your work query's `args`: `{ name, cursor? }`. */
    vQueryArgs: v.object({ name: v.string(), cursor: v.optional(cursor) }),
    /** Your work query's `returns`: a batch with an optional cursor, or idle. */
    vQueryReturns: vBatchResultFor(spec.batch, cursor),
    /** Your worker mutation's `args`: the batch the query returned. */
    vMutationArgs: asObjectValidator(spec.batch),
    /** Your worker mutation's `returns`: null, or `{ debounceMs?, cursor? }`. */
    vMutationReturns: vWorkerResultFor(cursor),
  };
}
