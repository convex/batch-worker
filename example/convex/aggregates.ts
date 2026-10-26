import { v } from "convex/values";
import { defineBatchWorkerValidators, ping } from "@convex-dev/batch-worker";
import { components, internal } from "./_generated/api.js";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server.js";

// Serial processing to update denormalized aggregates without write conflicts.
//
// Every score is inserted cheaply (no contention on insert). One loop folds
// batches of them into per-team totals. Because exactly one loop runs at a
// time, those hot aggregate rows have a single writer — so they never OCC
// against each other or against incoming scores, no matter the rate.
//
// This example treats scoreEvents as immutable, append-only events. Passing
// their values through the batch is safe under that assumption; an exclusive
// cursor skips events already folded into the totals. If events can be edited
// or deleted, return IDs and re-check their current state in the mutation.

const WORKER = "aggregates";

const BATCH_SIZE = 20;

const worker = {
  name: WORKER,
  workQuery: internal.aggregates.getBatch,
  workerMutation: internal.aggregates.processBatch,
};

/**
 * Record a score. Cheap insert, then ping — the aggregate update happens in the
 * background, so this mutation never contends with other scorers.
 */
export const recordScore = mutation({
  args: { team: v.string(), points: v.number() },
  handler: async (ctx, { team, points }) => {
    // `db.vars.commitTs` resolves to this mutation's commit timestamp. Every row
    // a mutation writes shares one value — getBatch below reads a whole tie at
    // once — and nothing can commit later with a smaller one.
    await ctx.db.insert("scoreEvents", {
      team,
      points,
      insertedAt: ctx.db.vars.commitTs,
    });
    await ping(ctx, components.batchWorker, worker);
  },
});

const { vQueryArgs, vQueryReturns, vMutationArgs } =
  defineBatchWorkerValidators({
    batch: {
      events: v.array(
        v.object({
          team: v.string(),
          points: v.number(),
        }),
      ),
    },
  });

export const getBatch = internalQuery({
  args: vQueryArgs,
  returns: vQueryReturns,
  handler: async (ctx, { cursor }) => {
    // Resume from after the last batch's commit timestamp.
    // We don't delete events, so the cursor allows us to avoid
    // handling scores multiple times.
    const events = await ctx.db
      .query("scoreEvents")
      .withIndex("insertedAt", (q) => q.gt("insertedAt", cursor ?? 0n))
      .take(BATCH_SIZE);
    if (events.length === 0) {
      return { kind: "idle" as const };
    }
    // The cursor is exclusive (`gt`), so a batch must not stop in the middle of
    // a commit timestamp — everything one transaction inserted shares one, and
    // whatever we left behind would be skipped. Read the rest of that tie in
    // (skipping the rows we already have) so the batch ends on a boundary.
    const lastCommitTs = events.at(-1)!.insertedAt as bigint;
    const taken = new Set(events.map((e) => e._id));
    const remainingEvents = await ctx.db
      .query("scoreEvents")
      .withIndex("insertedAt", (q) => q.eq("insertedAt", lastCommitTs))
      .collect();
    events.push(...remainingEvents.filter((e) => !taken.has(e._id)));
    return {
      kind: "work" as const,
      batch: {
        events: events.map((e) => ({
          team: e.team,
          points: e.points,
        })),
      },
      // Rows come back in commit order, so the last one is how far we got.
      cursor: lastCommitTs,
    };
  },
});

export const processBatch = internalMutation({
  args: vMutationArgs,
  handler: async (ctx, { events }) => {
    // Fold the batch into one delta per team first, so we touch each aggregate
    // row once regardless of how many events it covers.
    const deltas = new Map<string, number>();
    for (const { team, points } of events) {
      deltas.set(team, (deltas.get(team) ?? 0) + points);
    }
    for (const [team, delta] of deltas) {
      const row = await ctx.db
        .query("teamTotals")
        .withIndex("team", (q) => q.eq("team", team))
        .unique();
      if (row) {
        await ctx.db.patch("teamTotals", row._id, { total: row.total + delta });
      } else {
        await ctx.db.insert("teamTotals", { team, total: delta });
      }
    }
    // Returning nothing re-runs immediately to drain the rest.
  },
});

// For the dashboard UI
export const getTotals = query({
  args: {},
  handler: async (ctx) => {
    const totals = await ctx.db.query("teamTotals").take(100);
    // Scores still queued, waiting to be folded into the aggregates. Reading
    // from the worker's cursor keeps this off the tombstones too.
    const from = ((await ctx.runQuery(components.batchWorker.lib.getCursor, {
      name: WORKER,
    })) ?? 0n) as bigint;
    const pending = (
      await ctx.db
        .query("scoreEvents")
        .withIndex("insertedAt", (q) => q.gt("insertedAt", from))
        .take(1000)
    ).length;
    return {
      totals: Object.fromEntries(totals.map((t) => [t.team, t.total])),
      pending,
    };
  },
});

// status takes only a `{ name }`, so call it on the component.
export const workerStatus = query({
  args: {},
  handler: async (ctx) =>
    ctx.runQuery(components.batchWorker.lib.status, { name: WORKER }),
});
