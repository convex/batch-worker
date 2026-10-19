import { Workpool } from "@convex-dev/workpool";
import { defineBatchWorkerValidators, ping } from "@convex-dev/batch-worker";
import { v } from "convex/values";
import { components, internal } from "./_generated/api.js";
import { internalMutation, internalQuery } from "./_generated/server.js";

const pool = new Workpool(components.workpool, { maxParallelism: 10 });
const validators = defineBatchWorkerValidators({
  batch: {
    user: v.string(),
    events: v.array(v.object({ id: v.id("userEvents"), value: v.number() })),
  },
});

// Internal demo entry point. A public endpoint should derive the user from auth.
// npx convex run pooled:addEvents '{"user":"alice","values":[1,2,3]}'
export const addEvents = internalMutation({
  args: { user: v.string(), values: v.array(v.number()) },
  returns: v.null(),
  handler: async (ctx, { user, values }) => {
    for (const value of values) {
      await ctx.db.insert("userEvents", {
        user,
        value,
        insertedAt: ctx.db.vars.commitTs,
      });
    }
    await ping(ctx, components.batchWorker, {
      name: `user:${user}`,
      workQuery: internal.pooled.getBatch,
      workerMutation: internal.pooled.processBatch,
      workpool: pool,
    });
    return null;
  },
});

export const getBatch = internalQuery({
  args: validators.vQueryArgs,
  returns: validators.vQueryReturns,
  handler: async (ctx, { name, cursor }) => {
    const user = name.slice("user:".length);
    const events = await ctx.db
      .query("userEvents")
      .withIndex("user_insertedAt", (q) =>
        q.eq("user", user).gte("insertedAt", cursor ?? 0n),
      )
      .take(100);
    if (!events.length) return { kind: "idle" as const };
    return {
      batch: {
        user,
        events: events.map((event) => ({ id: event._id, value: event.value })),
      },
      cursor: events.at(-1)!.insertedAt,
    };
  },
});

export const processBatch = internalMutation({
  args: validators.vMutationArgs,
  returns: validators.vMutationReturns,
  handler: async (ctx, { user, events }) => {
    const previous = await ctx.db
      .query("userTotals")
      .withIndex("user", (q) => q.eq("user", user))
      .unique();
    const total =
      (previous?.total ?? 0) +
      events.reduce((sum, event) => sum + event.value, 0);
    if (previous) await ctx.db.patch("userTotals", previous._id, { total });
    else await ctx.db.insert("userTotals", { user, total });
    for (const event of events) await ctx.db.delete("userEvents", event.id);
    return null;
  },
});

export const getTotal = internalQuery({
  args: { user: v.string() },
  returns: v.number(),
  handler: async (ctx, { user }) => {
    const total = await ctx.db
      .query("userTotals")
      .withIndex("user", (q) => q.eq("user", user))
      .unique();
    return total?.total ?? 0;
  },
});
