import { v } from "convex/values";
import { mutation, query } from "./functions.js";
import {
  getOrCreateWorkerState,
  getWorker,
  kick as kickHelper,
  ping as pingHelper,
  start as startHelper,
  stop as stopHelper,
} from "./kick.js";
import { vConfig, vStatus, vWorkpool } from "./shared.js";

/**
 * The public component API. Apps call `ping` from `@convex-dev/batch-worker`
 * (it creates the function handles); `start`/`stop`/`status` take only a
 * `{ name }` and can be called here directly.
 */

export const ping = mutation({
  args: {
    name: v.string(),
    // Function handles, created app-side with `createFunctionHandle`.
    workQuery: v.string(),
    workerMutation: v.string(),
    config: v.optional(vConfig.partial()),
    workpool: v.optional(vWorkpool),
  },
  returns: v.null(),
  handler: async (ctx, args) => pingHelper(ctx, args),
});

export const start = mutation({
  args: { name: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => startHelper(ctx, args.name),
});

export const stop = mutation({
  args: { name: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => stopHelper(ctx, args.name),
});

/**
 * Manual recovery: cancel whatever is scheduled and start a fresh loop run and
 * monitor, from any status (including stopped). Use when the worker is wedged,
 * e.g. after its scheduled functions were canceled from the dashboard.
 */
export const kick = mutation({
  args: { name: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => kickHelper(ctx, args.name),
});

export const status = query({
  args: { name: v.string() },
  returns: v.union(v.null(), vStatus),
  handler: async (ctx, args) => {
    const worker = await getWorker(ctx, args.name);
    return worker?.status;
  },
});

/**
 * The cursor this worker last committed, or `null` if it doesn't have one.
 * Read it when your own queries want to scan the same range the worker does
 * (e.g. counting work still pending), so they skip the same tombstones.
 */
export const getCursor = query({
  args: { name: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const worker = await getWorker(ctx, args.name);
    if (!worker) return null;
    const state = await ctx.db.get("workerState", worker.stateId);
    return state?.cursor ?? null;
  },
});

/**
 * Overwrite the worker's cursor. Omit `cursor` to clear it, so the next scan
 * starts from the front again.
 *
 * Use this for migrations and recovery; in the steady state return a cursor
 * from the work query. The loop writes this document every iteration, so a
 * call made while the worker is busy is liable to hit a write conflict.
 *
 * Note: a worker must have been `ping`ed before the cursor can be set.
 */
export const setCursor = mutation({
  args: { name: v.string(), cursor: v.optional(v.any()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const worker = await getWorker(ctx, args.name);
    if (!worker) {
      throw new Error(
        `[setCursor] no worker named "${args.name}". Ping it first.`,
      );
    }
    const state = await getOrCreateWorkerState(ctx, worker);
    // Patching `undefined` removes the field.
    await ctx.db.patch("workerState", state._id, { cursor: args.cursor });
  },
});
