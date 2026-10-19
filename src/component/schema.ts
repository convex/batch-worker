import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { vConfig, vStatus, vWorkpool } from "./shared.js";

export default defineSchema({
  // One row per named worker. Written rarely — only on create/reconfigure,
  // run-state transitions, and the occasional monitor refresh. This lets
  // `ping`/`start` read it on every insert without OCC-conflicting with the
  // fast-looping `loop`, which doesn't write this doc while actively running.
  workers: defineTable({
    name: v.string(),
    // Function handles (created in the app via createFunctionHandle).
    workQuery: v.string(),
    workerMutation: v.string(),
    config: vConfig.partial(),
    workpool: v.optional(vWorkpool),
    status: vStatus,
    stateId: v.id("workerState"),
  }).index("name", ["name"]),

  // One row per named worker, owned and written by `loop` on every iteration
  // (and by `ping`/`start` only while the loop is idle or interruptibly
  // waiting). Kept separate from `workers` so its high churn doesn't conflict
  // with the per-insert `ping`/`start` read.
  workerState: defineTable({
    // Bumped each iteration & on every (re)start. A scheduled loop whose
    // generation no longer matches has been superseded and exits.
    generation: v.int64(),
    // When the loop last saw work or entered the running state.
    lastWorkTs: v.number(),
    // The currently-scheduled loop invocation, checked by the monitor and
    // canceled when a ping interrupts a wait.
    runnerId: v.optional(v.id("_scheduled_functions")),
    // Alternative to runnerId. Keep the cancel handle with the job so a pool
    // change can still cancel work in the old pool. runAt is its eligibility
    // time, not a promise that the pool has capacity then.
    workpoolJob: v.optional(
      v.object({
        id: v.string(),
        runAt: v.number(),
        cancel: v.string(),
      }),
    ),
    // The monitor that restarts the loop if it dies, scheduled to fire
    // `monitorLagMs` after the loop's next run and refreshed as it approaches.
    monitorId: v.optional(v.id("_scheduled_functions")),
    monitorRunAtMs: v.optional(v.number()),
    // How far the work query said it got, passed back to it as `args.cursor`.
    // Opaque here: it's whatever the app's query or worker mutation returned,
    // so the app's own validators type it. Written on the same patch that
    // schedules the next run. Absent until a batch returns one.
    cursor: v.optional(v.any()),
  }),
});
