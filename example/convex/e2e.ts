import { v } from "convex/values";
import { defineBatchWorkerValidators, ping } from "@convex-dev/batch-worker";
import { components, internal } from "./_generated/api.js";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server.js";

// Instrumented worker used by e2e.mjs to measure performance. Kept separate
// from the README example (different worker `name`) so it doesn't interfere.
const WORKER = "e2e";

const BATCH_SIZE = 25;

/**
 * Clear all e2e state between scenarios. We don't `stop` the worker — it drains
 * to idle on its own, and the next `enqueue` (a ping) resumes it. (`stop` would
 * leave it `stopped`, which only `start` — not `ping` — resumes.)
 */
export const reset = mutation({
  args: {},
  handler: async (ctx) => {
    for (const table of ["e2eEvents", "e2eSamples"] as const) {
      const docs = await ctx.db.query(table).collect();
      for (const d of docs) await ctx.db.delete(table, d._id);
    }
    // Clear this worker's cursor too, so the next scenario starts from scratch.
    await ctx.runMutation(components.batchWorker.lib.setCursor, {
      name: WORKER,
    });
  },
});

/** Insert `count` events in a single transaction, then ensure the worker runs. */
export const enqueue = mutation({
  args: { count: v.number() },
  handler: async (ctx, { count }) => {
    for (let i = 0; i < count; i++) {
      await ctx.db.insert("e2eEvents", {
        value: 1,
        updatedAt: ctx.db.vars.commitTs,
      });
    }
    await ping(ctx, components.batchWorker, {
      name: WORKER,
      workQuery: internal.e2e.getBatch,
      workerMutation: internal.e2e.processBatch,
    });
  },
});

const { vQueryArgs, vQueryReturns, vMutationArgs } =
  defineBatchWorkerValidators({
    batch: {
      ids: v.array(v.id("e2eEvents")),
    },
  });

export const getBatch = internalQuery({
  args: vQueryArgs,
  returns: vQueryReturns,
  handler: async (ctx, { cursor }) => {
    // Resume from the cursor so batch reads stay a fixed size no matter how
    // many rows (and tombstones) the harness has already churned through.
    const events = await ctx.db
      .query("e2eEvents")
      .withIndex("updatedAt", (q) => q.gte("updatedAt", cursor ?? 0n))
      .take(BATCH_SIZE);
    if (events.length === 0) {
      return { kind: "idle" as const };
    }
    return {
      kind: "work" as const,
      batch: {
        ids: events.map((e) => e._id),
      },
      cursor: events.at(-1)!.updatedAt,
    };
  },
});

export const processBatch = internalMutation({
  args: vMutationArgs,
  handler: async (ctx, { ids }) => {
    // Match the queue example: measure only rows still present in this snapshot.
    const candidates = await Promise.all(
      ids.map((id) => ctx.db.get("e2eEvents", id)),
    );
    const items = candidates.filter((item) => item !== null);
    if (items.length === 0) return;
    const now = Date.now();
    const latencies = items.map((b) => now - b._creationTime);
    await ctx.db.insert("e2eSamples", {
      processedAt: now,
      batchSize: items.length,
      oldestLatencyMs: Math.max(...latencies),
      newestLatencyMs: Math.min(...latencies),
    });
    for (const b of items) {
      await ctx.db.delete("e2eEvents", b._id);
    }
  },
});

export const samples = query({
  args: {},
  handler: async (ctx) => ctx.db.query("e2eSamples").take(100000),
});

export const pending = query({
  args: {},
  handler: async (ctx) => {
    const from = ((await ctx.runQuery(components.batchWorker.lib.getCursor, {
      name: WORKER,
    })) ?? 0n) as bigint;
    return (
      await ctx.db
        .query("e2eEvents")
        .withIndex("updatedAt", (q) => q.gte("updatedAt", from))
        .take(100000)
    ).length;
  },
});

export const status = query({
  args: {},
  handler: async (ctx) =>
    ctx.runQuery(components.batchWorker.lib.status, { name: WORKER }),
});

export const start = mutation({
  args: {},
  handler: async (ctx) =>
    ctx.runMutation(components.batchWorker.lib.start, { name: WORKER }),
});

export const stop = mutation({
  args: {},
  handler: async (ctx) =>
    ctx.runMutation(components.batchWorker.lib.stop, { name: WORKER }),
});
