import { v } from "convex/values";
import { SECOND, RateLimiter } from "@convex-dev/rate-limiter";
import { defineBatchWorkerValidators, ping } from "@convex-dev/batch-worker";
import { components, internal } from "./_generated/api.js";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server.js";

// Batching async LLM requests, paced by a token budget.
//
// Each request records how many input tokens it will cost. The worker collects
// a batch, reserves that many tokens against a rate limit, and uses the
// returned `retryAfter` to schedule the (async) LLM call for when we're allowed
// to make it. When the call comes back, a mutation writes the responses and
// reserves the output tokens it actually used against the *same* budget — so a
// batch that generates a lot of output naturally delays the next requests.

const WORKER = "llm";

// Small so a burst forms several batches that drain one after another, instead
// of a single batch swallowing everything.
const BATCH_SIZE = 5;

// A real budget (e.g. 200k tokens/min) is impossible to hit by clicking, so
// this demo uses a deliberately tiny one — ~60 tokens/sec with a 300-token
// burst. Each request costs ~150 tokens (see `submitRequest` below), so even a
// couple of them blow past the budget and you can watch batches queue up and
// drain over several seconds.
const rateLimiter = new RateLimiter(components.rateLimiter, {
  // One budget for all tokens, input and output. Model it on your provider's
  // tokens-per-minute limit.
  llmTokens: {
    kind: "token bucket",
    rate: 300,
    period: 5 * SECOND,
    capacity: 300,
  },
});

const worker = {
  name: WORKER,
  workQuery: internal.rateLimited.getBatch,
  workerMutation: internal.rateLimited.startBatch,
  // Wait a beat before the first call so a burst of requests batches together.
  config: { debounceMs: 1000 },
};

/**
 * Submit an LLM request. It's recorded in the table; the worker sends it (with
 * others) in a batch. `inputTokens` is your estimate of the prompt's cost.
 */
export const submitRequest = mutation({
  args: { prompt: v.string(), inputTokens: v.number() },
  handler: async (ctx, { prompt, inputTokens }) => {
    await ctx.db.insert("llmRequests", {
      prompt,
      inputTokens,
      state: "pending",
      // Lets the worker cursor through pending requests in commit order rather
      // than rescanning from the front of the range.
      updatedAt: ctx.db.vars.commitTs,
    });
    await ping(ctx, components.batchWorker, worker);
  },
});

// Return IDs so the mutation can check for changes by other mutations before
// claiming each request, using its current prompt and token estimate.
const { vQueryArgs, vQueryReturns, vMutationArgs, vMutationReturns } =
  defineBatchWorkerValidators({ batch: { ids: v.array(v.id("llmRequests")) } });

export const getBatch = internalQuery({
  args: vQueryArgs,
  returns: vQueryReturns,
  handler: async (ctx, { cursor }) => {
    // TODO: also pick up "started" requests whose action never reported back
    // (e.g. `startedAt` older than some timeout) so a crashed batch isn't
    // stranded. That scan walks the (small) "started" range, so it doesn't use
    // the cursor. Left out here to keep the example focused.
    //
    // Nothing is deleted here — requests are patched from "pending" to
    // "started" — but patching a row out of the pending range leaves a
    // tombstone there just the same, so the cursor still earns its keep.
    const pending = await ctx.db
      .query("llmRequests")
      .withIndex("state_updatedAt", (q) =>
        q.eq("state", "pending").gte("updatedAt", cursor ?? 0n),
      )
      .take(BATCH_SIZE);
    if (pending.length === 0) {
      return { kind: "idle" as const };
    }
    return {
      kind: "work" as const,
      batch: {
        ids: pending.map((r) => r._id),
      },
      // Rows come back in commit order, so the last one is how far we got.
      cursor: pending.at(-1)!.updatedAt,
    };
  },
});

/**
 * Worker mutation: reserve the batch's input-token budget, mark the requests
 * started, and schedule the LLM call for when the budget clears.
 */
export const startBatch = internalMutation({
  args: vMutationArgs,
  returns: vMutationReturns,
  handler: async (ctx, { ids }) => {
    // Other mutations may have changed, claimed, or deleted these requests
    // since the query's snapshot. This worker's prior claims are already visible.
    const candidates = await Promise.all(
      ids.map((id) => ctx.db.get("llmRequests", id)),
    );
    const requests = candidates.filter(
      (r): r is NonNullable<typeof r> => r !== null && r.state === "pending",
    );
    if (requests.length === 0) return null;
    const totalInputTokens = requests.reduce((a, r) => a + r.inputTokens, 0);

    // Reserve the whole batch's input tokens up front. `reserve: true` never
    // rejects — it borrows against future capacity — and `retryAfter` is how
    // long until we're back under the limit.
    const { retryAfter } = await rateLimiter.limit(ctx, "llmTokens", {
      count: totalInputTokens,
      reserve: true,
    });

    // Claim only requests that are still pending in this mutation's snapshot.
    // The next round's query sees these claims and excludes them from pending.
    // Patches refresh `updatedAt` too, so the "started" range stays in claim
    // order for the recovery scan sketched in getBatch's TODO.
    const startedAt = Date.now();
    for (const { _id } of requests) {
      await ctx.db.patch("llmRequests", _id, {
        state: "started",
        startedAt,
        updatedAt: ctx.db.vars.commitTs,
      });
    }

    // Make the actual call when the reservation clears. Pass the prompts
    // through so the action doesn't have to re-read them.
    await ctx.scheduler.runAfter(
      retryAfter ?? 0,
      internal.rateLimited.runBatch,
      {
        prompts: requests.map((r) => ({ id: r._id, prompt: r.prompt })),
      },
    );

    // Don't assemble the next batch until this one's budget is paid off.
    if (retryAfter) {
      return { debounceMs: retryAfter };
    }
    return null;
  },
});

/**
 * The async step: call the LLM for the batch. This is the only piece that has
 * to be an action.
 */
export const runBatch = internalAction({
  args: {
    prompts: v.array(v.object({ id: v.id("llmRequests"), prompt: v.string() })),
  },
  handler: async (ctx, { prompts }) => {
    // --- A real batched LLM call would go here, e.g.: ---
    // const anthropic = new Anthropic();
    // const batch = await anthropic.messages.batches.create({
    //   requests: prompts.map(({ id, prompt }) => ({
    //     custom_id: id,
    //     params: { model, max_tokens, messages: [{ role: "user", content: prompt }] },
    //   })),
    // });
    // ...poll the batch, then map results back to ids...

    // For the example, fake a response + output-token count per request.
    const responses = prompts.map(({ id, prompt }) => ({
      id,
      response: `Echo: ${prompt}`,
      outputTokens: prompt.length,
    }));

    await ctx.runMutation(internal.rateLimited.finishBatch, { responses });
  },
});

/**
 * Write the responses back and account for the output tokens we actually used.
 */
export const finishBatch = internalMutation({
  args: {
    responses: v.array(
      v.object({
        id: v.id("llmRequests"),
        response: v.string(),
        outputTokens: v.number(),
      }),
    ),
  },
  handler: async (ctx, { responses }) => {
    let totalOutputTokens = 0;
    for (const { id, response, outputTokens } of responses) {
      totalOutputTokens += outputTokens;
      await ctx.db.patch("llmRequests", id, {
        state: "finished",
        response,
        outputTokens,
        updatedAt: ctx.db.vars.commitTs,
      });
      // Per-response follow-up could go here, e.g.:
      // - await ctx.runMutation(internal.foo.onLlmComplete, { id, response });
      // - kick off a downstream workflow / another batch worker
    }

    // We only learn the output cost after the call, so reserve it now against
    // the same budget — so a batch that generated a lot of output pushes back
    // the next requests, which could only estimate their input cost up front.
    await rateLimiter.limit(ctx, "llmTokens", {
      count: totalOutputTokens,
      reserve: true,
    });

    // No ping needed — finishing doesn't create new pending work; submitRequest
    // wakes the loop when new requests arrive.
  },
});

export const listRequests = query({
  args: {},
  handler: async (ctx) => {
    // Newest first, so freshly submitted prompts show up at the top.
    const requests = await ctx.db.query("llmRequests").order("desc").take(50);
    return requests.map((r) => ({
      prompt: r.prompt,
      state: r.state,
      response: r.response ?? null,
    }));
  },
});

// Live counts per state, so the UI can show the queue backing up and draining.
export const stats = query({
  args: {},
  handler: async (ctx) => {
    const count = async (state: "started" | "finished") =>
      (
        await ctx.db
          .query("llmRequests")
          .withIndex("state_updatedAt", (q) => q.eq("state", state))
          .take(500)
      ).length;
    // The pending count reads from the worker's cursor, like the work query.
    const from = ((await ctx.runQuery(components.batchWorker.lib.getCursor, {
      name: WORKER,
    })) ?? 0n) as bigint;
    const pending = (
      await ctx.db
        .query("llmRequests")
        .withIndex("state_updatedAt", (q) =>
          q.eq("state", "pending").gte("updatedAt", from),
        )
        .take(500)
    ).length;
    return {
      pending,
      started: await count("started"),
      finished: await count("finished"),
    };
  },
});

// status takes only a `{ name }`, so call it on the component.
export const workerStatus = query({
  args: {},
  handler: async (ctx) =>
    ctx.runQuery(components.batchWorker.lib.status, { name: WORKER }),
});
