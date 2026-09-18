import { v } from "convex/values";
import { defineBatchWorkerValidators, ping } from "@convex-dev/batch-worker";
import { components, internal } from "./_generated/api.js";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server.js";

// Use distinct `name`s if you want several independent queues backed by the
// same component.
const WORKER = "events";

const BATCH_SIZE = 10;

/**
 * Add an event to the queue. After inserting, ping the worker so its loop runs
 * — it'll batch up and process everything.
 */
export const addEvent = mutation({
  args: { value: v.number() },
  handler: async (ctx, { value }) => {
    // `db.vars.commitTs` resolves to this mutation's commit timestamp. Every row
    // a mutation writes shares one value, and nothing can commit later with a
    // smaller one, which is what makes it safe to use as a cursor.
    await ctx.db.insert("events", { value, insertedAt: ctx.db.vars.commitTs });
    await ping(ctx, components.batchWorker, {
      name: WORKER,
      workQuery: internal.example.getBatch,
      workerMutation: internal.example.processBatch,
    });
  },
});

const { vQueryArgs, vQueryReturns, vMutationArgs, vMutationReturns } =
  defineBatchWorkerValidators({ batch: { ids: v.array(v.id("events")) } });

/**
 * The work query: returns the next batch of work, or `idle` when the queue is
 * empty.
 */
export const getBatch = internalQuery({
  args: vQueryArgs,
  returns: vQueryReturns,
  handler: async (ctx, { cursor }) => {
    // Pick up where the last batch stopped, skipping the tombstone every row
    // we deleted left at the front of the table. `gte` because the cursor is
    // inclusive: everything one mutation inserts shares a commit timestamp,
    // and a batch can end mid-tie.
    const events = await ctx.db
      .query("events")
      .withIndex("insertedAt", (q) => q.gte("insertedAt", cursor ?? 0n))
      .take(BATCH_SIZE);
    if (events.length === 0) {
      return { kind: "idle" as const };
    }
    return {
      kind: "work" as const,
      batch: { ids: events.map((e) => e._id) },
      // Rows come back in commit order, so the last one is how far we got.
      // The component commits this with the batch and hands it back above.
      cursor: events.at(-1)!.insertedAt,
    };
  },
});

/**
 * The worker mutation: processes a batch. It owns cleanup, deleting the rows it
 * processed so the table stays small. Returning nothing re-runs immediately to
 * drain the rest.
 */
export const processBatch = internalMutation({
  args: vMutationArgs,
  returns: vMutationReturns,
  handler: async (ctx, { ids }) => {
    // The query can read an older snapshot. Use current values and skip rows
    // already deleted by a previous batch or another mutation.
    const candidates = await Promise.all(
      ids.map((id) => ctx.db.get("events", id)),
    );
    const events = candidates.filter((event) => event !== null);
    if (events.length === 0) return null;
    const sum = events.reduce((a, e) => a + e.value, 0);
    const totals = await ctx.db
      .query("totals")
      .withIndex("key", (q) => q.eq("key", "all"))
      .unique();
    if (totals) {
      await ctx.db.patch("totals", totals._id, {
        total: totals.total + sum,
        count: totals.count + events.length,
      });
    } else {
      await ctx.db.insert("totals", {
        key: "all",
        total: sum,
        count: events.length,
      });
    }
    for (const { _id } of events) {
      await ctx.db.delete("events", _id);
    }
  },
});

export const getTotals = query({
  args: {},
  handler: async (ctx) => {
    const totals = await ctx.db
      .query("totals")
      .withIndex("key", (q) => q.eq("key", "all"))
      .unique();
    // Events left in the queue waiting for the worker to pick them up. Reading
    // from the worker's cursor keeps this off the tombstones too.
    const from = ((await ctx.runQuery(components.batchWorker.lib.getCursor, {
      name: WORKER,
    })) ?? 0n) as bigint;
    const pending = (
      await ctx.db
        .query("events")
        .withIndex("insertedAt", (q) => q.gte("insertedAt", from))
        .take(1000)
    ).length;
    return {
      total: totals?.total ?? 0,
      count: totals?.count ?? 0,
      pending,
    };
  },
});

// start/stop/status take only a `{ name }`, so call them on the component.
export const workerStatus = query({
  args: {},
  handler: async (ctx) =>
    ctx.runQuery(components.batchWorker.lib.status, { name: WORKER }),
});
