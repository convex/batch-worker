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
} from "../component/shared.js";

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
 * The work query may read an older snapshot than the worker mutation, but each
 * round sees this worker's committed writes from previous rounds. Return IDs
 * and re-fetch them when processing depends on changes by other writers;
 * otherwise, values can be passed through the batch. A write by ID does not
 * validate the query's values.
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
  },
): Promise<void> {
  const [workQuery, workerMutation] = await Promise.all([
    createFunctionHandle(args.workQuery),
    createFunctionHandle(args.workerMutation),
  ]);
  await ctx.runMutation(component.lib.ping, {
    name: args.name,
    workQuery,
    workerMutation,
    config: args.config ?? {},
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
