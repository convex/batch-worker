import {
  createFunctionHandle,
  type DefaultFunctionArgs,
  type FunctionReference,
  type GenericActionCtx,
  type GenericDataModel,
  type GenericMutationCtx,
} from "convex/server";
import type { ComponentApi } from "../component/_generated/component.js";
import {
  type BatchQueryArgs,
  type BatchResult,
  type Config,
  type DefaultCursor,
  type WorkerResult,
  type WorkpoolConfig,
} from "../component/shared.js";

/**
 * The portion of a Workpool instance used by BatchWorker. Kept structural so
 * scheduler-only users don't need to install Workpool, even for its types.
 * Requires a Workpool version supporting `onFailure`.
 */
export type BatchWorkpool = {
  component: {
    lib: {
      enqueue: FunctionReference<"mutation", "internal">;
      cancel: FunctionReference<"mutation", "internal">;
    };
  };
  options: Pick<WorkpoolConfig, "maxParallelism" | "logLevel">;
};

export {
  defineBatchWorkerValidators,
  vBatchQueryArgs,
  vBatchResult,
  vDefaultCursor,
  vWorkerResult,
  type BatchResult,
  type BatchQueryArgs,
  type DefaultCursor,
  type WorkerResult,
} from "../component/shared.js";
export type {
  Config as WorkerConfig,
  Status as WorkerStatus,
} from "../component/shared.js";

/**
 * Register-or-refresh a worker and make sure its loop is running. Call it right
 * after inserting work. Idempotent and cheap (a no-op while the loop is
 * already running).
 *
 * You provide:
 *  - a **work query** that returns the next batch or `idle`, and
 *  - a **worker mutation** that processes a batch and owns its cleanup. It may
 *    return `{ debounceMs }` to throttle the loop.
 *
 * Validate both with {@link defineBatchWorkerValidators}. The cursor type is
 * taken from the work query's `cursor` arg, and both return types are checked
 * against it.
 *
 * @example
 * ```ts
 * export const enqueue = mutation({
 *   args: { task: v.string() },
 *   handler: async (ctx, { task }) => {
 *     await ctx.db.insert("tasks", { task });
 *     await ping(ctx, components.batchWorker, {
 *       name: "tasks",
 *       workQuery: internal.tasks.getBatch,
 *       workerMutation: internal.tasks.processBatch,
 *     });
 *   },
 * });
 * ```
 */
export async function ping<
  Batch extends DefaultFunctionArgs,
  Cursor = DefaultCursor,
>(
  ctx: MutationCtx | ActionCtx,
  component: ComponentApi,
  args: {
    /** Worker name — also passed to your query as `args.name`. */
    name: string;
    /** Returns the next batch of work, or `idle`. */
    workQuery: FunctionReference<
      "query",
      "internal",
      BatchQueryArgs<Cursor>,
      BatchResult<Batch, NoInfer<Cursor>>
    >;
    /** Processes a batch returned by the work query. */
    workerMutation: FunctionReference<
      "mutation",
      "internal",
      Batch,
      WorkerResult<NoInfer<Cursor>> | void
    >;
    /** Loop configuration. */
    config?: Partial<Config>;
    /**
     * Execute each iteration in this shared Workpool. Batches are fetched
     * only when admitted. Omit to use the scheduler directly.
     * Failures retry via onFailure; direct pool cancellations need `lib.kick`.
     */
    workpool?: BatchWorkpool;
  },
): Promise<void> {
  const [workQuery, workerMutation] = await Promise.all([
    createFunctionHandle(args.workQuery),
    createFunctionHandle(args.workerMutation),
  ]);
  let workpool: WorkpoolConfig | undefined;
  if (args.workpool) {
    const [enqueue, cancel] = await Promise.all([
      createFunctionHandle(args.workpool.component.lib.enqueue),
      createFunctionHandle(args.workpool.component.lib.cancel),
    ]);
    workpool = {
      enqueue,
      cancel,
      ...(args.workpool.options.maxParallelism !== undefined
        ? { maxParallelism: args.workpool.options.maxParallelism }
        : {}),
      ...(args.workpool.options.logLevel !== undefined
        ? { logLevel: args.workpool.options.logLevel }
        : {}),
    };
  }
  await ctx.runMutation(component.lib.ping, {
    name: args.name,
    workQuery,
    workerMutation,
    config: args.config ?? {},
    ...(workpool ? { workpool } : {}),
  });
}

type MutationCtx = Pick<
  GenericMutationCtx<GenericDataModel>,
  "runQuery" | "runMutation"
>;
type ActionCtx = Pick<
  GenericActionCtx<GenericDataModel>,
  "runQuery" | "runMutation" | "runAction"
>;
