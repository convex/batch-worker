import { createFunctionHandle, type FunctionHandle } from "convex/server";
import { v } from "convex/values";
import { internal } from "./_generated/api.js";
import { internalMutation, type MutationCtx } from "./functions.js";
import { continueRunning, getWorker } from "./kick.js";
import {
  MONITOR_LAG_MS,
  MONITOR_REFRESH_WITHIN_MS,
  type WorkpoolConfig,
} from "./shared.js";

// Workpool's enqueue wire protocol. No runtime dependency: Workpool itself
// uses BatchWorker as its scheduler-backed driver.
type EnqueueArgs = {
  fnHandle: string;
  fnName: string;
  fnType: "mutation";
  fnArgs: { name: string; generation: bigint };
  runAt: number;
  config: Pick<WorkpoolConfig, "maxParallelism" | "logLevel">;
  onComplete: {
    onStatusHandle: { failed: string };
    context: { name: string; generation: bigint };
  };
};

export async function enqueueLoop(
  ctx: MutationCtx,
  pool: WorkpoolConfig,
  args: { name: string; generation: bigint },
  runAt: number,
): Promise<string> {
  const [fnHandle, failed] = await Promise.all([
    createFunctionHandle(internal.loop.loop),
    createFunctionHandle(internal.workpool.onFailure),
  ]);
  return ctx.runMutation(
    pool.enqueue as FunctionHandle<"mutation", EnqueueArgs, string>,
    {
      fnHandle,
      fnName: `batchWorker:${args.name}`,
      fnType: "mutation",
      fnArgs: args,
      runAt,
      config: {
        ...(pool.maxParallelism !== undefined
          ? { maxParallelism: pool.maxParallelism }
          : {}),
        ...(pool.logLevel !== undefined ? { logLevel: pool.logLevel } : {}),
      },
      // This is how Workpool's client serializes its onFailure option.
      onComplete: { onStatusHandle: { failed }, context: args },
    },
  );
}

export async function cancelWorkpoolJob(
  ctx: MutationCtx,
  job: { id: string; cancel: string },
): Promise<void> {
  await ctx.runMutation(
    job.cancel as FunctionHandle<"mutation", { id: string }, null>,
    { id: job.id },
  );
}

/** Only failed iterations invoke this; success schedules its own successor. */
export const onFailure = internalMutation({
  args: {
    workId: v.string(),
    context: v.object({ name: v.string(), generation: v.int64() }),
    result: v.object({ kind: v.literal("failed"), error: v.string() }),
  },
  returns: v.null(),
  handler: async (ctx, { workId, context: { name, generation }, result }) => {
    const worker = await getWorker(ctx, name);
    if (!worker?.workpool || worker.status.kind === "stopped") return null;
    const state = await ctx.db.get("workerState", worker.stateId);
    if (state?.generation !== generation || state.workpoolJob?.id !== workId) {
      return null;
    }
    ctx.log.error(`[onFailure] "${name}" loop failed: ${result.error}`);
    ctx.log.event("restart", { name });
    await continueRunning(
      ctx,
      worker,
      Math.max(
        MONITOR_REFRESH_WITHIN_MS,
        worker.config.monitorLagMs ?? MONITOR_LAG_MS,
      ),
    );
    return null;
  },
});
