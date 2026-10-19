import { v } from "convex/values";
import { internalMutation } from "./functions.js";
import {
  cancelMonitor,
  continueRunning,
  ensureMonitored,
  getOrCreateWorkerState,
  getWorker,
} from "./kick.js";
import { STUCK_RUNNER_GRACE_MS } from "./shared.js";

/**
 * Liveness watchdog. Scheduled ~`monitorLagMs` after the loop's next run by
 * the scheduling path, and pushed back as the loop keeps running. It therefore
 * only fires if the loop failed to run on time:
 *  - loop runner stuck pending in the past (running or waiting) → cancel it
 *    and restart the loop.
 *  - worker stopped/idle → nothing to watch, clear ourselves.
 *  - loop runner dead → restart the loop.
 *  - loop runner scheduled → we fired early; re-arm behind it.
 */
export const monitor = internalMutation({
  args: { name: v.string() },
  handler: async (ctx, { name }) => {
    const worker = await getWorker(ctx, name);
    if (!worker) {
      ctx.log.debug(`[monitor] "${name}" not found, bailing`);
      return;
    }

    const state = await getOrCreateWorkerState(ctx, worker);
    // A monitor scheduled before switching to a pool must not restart its job.
    if (worker.workpool) {
      await cancelMonitor(ctx, state);
      return;
    }
    const loop =
      state.runnerId &&
      (await ctx.db.system.get("_scheduled_functions", state.runnerId));
    const now = Date.now();

    // A run the scheduler keeps retrying after system failures stays "pending"
    // at its original scheduledTime; it must be canceled and replaced or the
    // worker stays wedged (pings no-op in every status). This can happen while
    // running or while waiting (idle with a scheduled run), so it takes
    // priority over the status dispatch below. `stop` cancels the runner, so a
    // stopped worker never has one.
    if (
      loop &&
      loop.state.kind === "pending" &&
      loop.scheduledTime <= now - STUCK_RUNNER_GRACE_MS &&
      worker.status.kind !== "stopped"
    ) {
      ctx.log.error(
        `[monitor] "${name}" loop stuck pending since ` +
          `${new Date(loop.scheduledTime).toISOString()} — restarting`,
      );
      ctx.log.event("restart", { name, stuck: true });
      await ctx.scheduler.cancel(loop._id);
      await continueRunning(ctx, worker, 0);
      return;
    }

    if (worker.status.kind !== "running") {
      await cancelMonitor(ctx, state);
      ctx.log.debug(`[monitor] "${name}" ${worker.status.kind}, no-op`);
      return;
    }

    // Pending is enough to know the loop is alive: another mutation can never
    // observe a scheduled mutation as inProgress. We fired early; re-arm
    // behind its next run so we keep trailing it.
    if (loop && loop.state.kind === "pending") {
      await ensureMonitored(ctx, worker, loop.scheduledTime);
      return;
    }

    ctx.log.error(`[monitor] "${name}" loop is not running — restarting`);
    ctx.log.event("restart", { name });
    await continueRunning(ctx, worker, 0);
  },
});
