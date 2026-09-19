import { v, type Infer } from "convex/values";
import { internal } from "./_generated/api.js";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "./_generated/server.js";
import type { Id } from "./_generated/dataModel.js";

// Run with benchmark.mjs. All endpoints are internal, and fixtures are scoped
// to a unique run ID. No production queues or worker state are touched.
const vIds = v.array(v.id("benchmarkItems"));
const vItems = v.array(
  v.object({ id: v.id("benchmarkItems"), value: v.number() }),
);
const vMode = v.union(
  v.literal("patch"),
  v.literal("refetch"),
  v.literal("refetchValues"),
);
type Mode = Infer<typeof vMode>;
const vCase = {
  runId: v.string(),
  batchSize: v.number(),
  paddingBytes: v.number(),
};

function boundedInteger(value: number, min: number, max: number) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Expected an integer from ${min} to ${max}, got ${value}`);
  }
}

export const seed = internalMutation({
  args: vCase,
  returns: vIds,
  handler: async (ctx, { runId, batchSize, paddingBytes }) => {
    boundedInteger(batchSize, 1, 500);
    boundedInteger(paddingBytes, 0, 16384);
    const ids: Id<"benchmarkItems">[] = [];
    for (let i = 0; i < batchSize; i++) {
      ids.push(
        await ctx.db.insert("benchmarkItems", {
          runId,
          value: i,
          padding: "x".repeat(paddingBytes),
          processed: false,
        }),
      );
    }
    return ids;
  },
});

export const reset = internalMutation({
  args: { ids: vIds },
  returns: v.null(),
  handler: async (ctx, { ids }) => {
    for (const id of ids) {
      await ctx.db.patch("benchmarkItems", id, {
        processed: false,
        result: undefined,
      });
    }
    return null;
  },
});

const vQueryArgs = { runId: v.string(), batchSize: v.number() };

export const batchIds = internalQuery({
  args: vQueryArgs,
  returns: vIds,
  handler: async (ctx, { runId, batchSize }) => {
    boundedInteger(batchSize, 1, 500);
    const rows = await ctx.db
      .query("benchmarkItems")
      .withIndex("by_runId_processed", (q) =>
        q.eq("runId", runId).eq("processed", false),
      )
      .take(batchSize);
    return rows.map((row) => row._id);
  },
});

export const batchValues = internalQuery({
  args: vQueryArgs,
  returns: vItems,
  handler: async (ctx, { runId, batchSize }) => {
    boundedInteger(batchSize, 1, 500);
    const rows = await ctx.db
      .query("benchmarkItems")
      .withIndex("by_runId_processed", (q) =>
        q.eq("runId", runId).eq("processed", false),
      )
      .take(batchSize);
    // Carry only needed fields, not the artificial padding.
    return rows.map((row) => ({ id: row._id, value: row.value }));
  },
});

export const patch = internalMutation({
  args: { items: vItems },
  returns: v.number(),
  handler: async (ctx, { items }) => {
    // Intentionally assumes the query's values and eligibility are unchanged.
    // This is the comparison baseline, not the recommended general pattern.
    await Promise.all(
      items.map(({ id, value }) =>
        ctx.db.patch("benchmarkItems", id, {
          processed: true,
          result: value + 1,
        }),
      ),
    );
    return items.length;
  },
});

async function refetchRows(ctx: MutationCtx, ids: Id<"benchmarkItems">[]) {
  // Each concurrent task gets, checks, and patches one row. A patch can start
  // as soon as that row is ready, without waiting for every get to finish.
  const processed = await Promise.all(
    ids.map(async (id) => {
      const row = await ctx.db.get("benchmarkItems", id);
      if (!row || row.processed) return 0;
      await ctx.db.patch("benchmarkItems", id, {
        processed: true,
        result: row.value + 1,
      });
      return 1;
    }),
  );
  return processed.reduce<number>((sum, count) => sum + count, 0);
}

export const refetch = internalMutation({
  args: { ids: vIds },
  returns: v.number(),
  handler: async (ctx, { ids }) => await refetchRows(ctx, ids),
});

export const refetchValues = internalMutation({
  // Same validator and payload as patch; supplied values are intentionally
  // ignored so the re-fetch logic is identical to the IDs-only variant.
  args: { items: vItems },
  returns: v.number(),
  handler: async (ctx, { items }) =>
    await refetchRows(
      ctx,
      items.map(({ id }) => id),
    ),
});

export const iteration = internalMutation({
  args: { ...vCase, mode: vMode, trial: v.number(), warmup: v.boolean() },
  returns: v.number(),
  handler: async (
    ctx,
    { runId, batchSize, paddingBytes, mode, trial, warmup },
  ): Promise<number> => {
    // Tag the root completion log so the harness can extract server execution
    // time and database usage, excluding setup/verification and action overhead.
    console.log(
      `batch-read-bench|${runId}|${batchSize}|${paddingBytes}|${trial}|${mode}|${warmup}`,
    );
    const args = { runId, batchSize };
    if (mode === "patch" || mode === "refetchValues") {
      const items = await ctx.runQuery(internal.benchmark.batchValues, args, {
        useStaleSnapshot: true,
      });
      return await ctx.runMutation(
        mode === "patch"
          ? internal.benchmark.patch
          : internal.benchmark.refetchValues,
        { items },
      );
    }
    const ids = await ctx.runQuery(internal.benchmark.batchIds, args, {
      useStaleSnapshot: true,
    });
    return await ctx.runMutation(internal.benchmark.refetch, { ids });
  },
});

export const verify = internalQuery({
  args: { ids: vIds },
  returns: v.null(),
  handler: async (ctx, { ids }) => {
    for (const id of ids) {
      const row = await ctx.db.get("benchmarkItems", id);
      if (!row || !row.processed || row.result !== row.value + 1) {
        throw new Error(`Incorrect benchmark result for ${id}`);
      }
    }
    return null;
  },
});

export const cleanup = internalMutation({
  args: { runId: v.string() },
  returns: v.number(),
  handler: async (ctx, { runId }) => {
    const rows = await ctx.db
      .query("benchmarkItems")
      .withIndex("by_runId_processed", (q) => q.eq("runId", runId))
      .take(500);
    for (const row of rows) await ctx.db.delete("benchmarkItems", row._id);
    return rows.length;
  },
});

export const run = internalAction({
  args: { ...vCase, trials: v.number(), warmups: v.number() },
  returns: v.array(
    v.object({ mode: vMode, trial: v.number(), elapsedMs: v.number() }),
  ),
  handler: async (ctx, { trials, warmups, ...spec }) => {
    boundedInteger(trials, 1, 100);
    boundedInteger(warmups, 0, 20);
    const samples: {
      mode: Mode;
      trial: number;
      elapsedMs: number;
    }[] = [];
    try {
      const ids = await ctx.runMutation(internal.benchmark.seed, spec);
      // Cycle all six orders to balance position and preceding-variant effects.
      const orders: Mode[][] = [
        ["patch", "refetch", "refetchValues"],
        ["refetch", "refetchValues", "patch"],
        ["refetchValues", "patch", "refetch"],
        ["refetchValues", "refetch", "patch"],
        ["refetch", "patch", "refetchValues"],
        ["patch", "refetchValues", "refetch"],
      ];
      for (let trial = -warmups; trial < trials; trial++) {
        const modes =
          orders[((trial % orders.length) + orders.length) % orders.length];
        for (const mode of modes) {
          await ctx.runMutation(internal.benchmark.reset, { ids });
          // Date.now advances in actions; it is fixed inside mutations. Server
          // completion logs provide a second, more precise execution metric.
          const start = Date.now();
          const count = await ctx.runMutation(internal.benchmark.iteration, {
            ...spec,
            mode,
            trial,
            warmup: trial < 0,
          });
          const elapsedMs = Date.now() - start;
          if (count !== spec.batchSize)
            throw new Error(`Expected ${spec.batchSize} patches, got ${count}`);
          await ctx.runQuery(internal.benchmark.verify, { ids });
          if (trial >= 0) samples.push({ mode, trial, elapsedMs });
        }
      }
      return samples;
    } finally {
      await ctx.runMutation(internal.benchmark.cleanup, { runId: spec.runId });
    }
  },
});
