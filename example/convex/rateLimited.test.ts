import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { initConvexTest } from "./setup.test";
import { api, internal } from "./_generated/api";

describe("rate-limited LLM batches", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("processes every request and fills in responses", async () => {
    const t = initConvexTest();
    for (let i = 0; i < 25; i++) {
      await t.mutation(api.rateLimited.submitRequest, {
        prompt: `prompt ${i}`,
        inputTokens: 100,
      });
    }

    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const requests = await t.query(api.rateLimited.listRequests, {});
    expect(requests).toHaveLength(25);
    expect(requests.every((r) => r.state === "finished")).toBe(true);
    expect(requests.every((r) => r.response?.startsWith("Echo:"))).toBe(true);
  });

  test("re-checks stale candidates before reserving tokens and scheduling work", async () => {
    const t = initConvexTest();
    const ids = await t.run(async (ctx) => {
      const ids = [];
      for (let i = 0; i < 3; i++) {
        ids.push(
          await ctx.db.insert("llmRequests", {
            prompt: `old ${i}`,
            inputTokens: 1,
            state: "pending",
            updatedAt: ctx.db.vars.commitTs,
          }),
        );
      }
      return ids;
    });
    const batch = await t.query(internal.rateLimited.getBatch, { name: "llm" });
    if (!batch.batch) throw new Error("Expected work");
    await t.run(async (ctx) => {
      await ctx.db.patch("llmRequests", ids[0], {
        prompt: "current prompt",
        inputTokens: 2,
      });
      await ctx.db.patch("llmRequests", ids[1], {
        state: "finished",
        response: "already done",
      });
      await ctx.db.delete("llmRequests", ids[2]);
    });
    await t.mutation(internal.rateLimited.startBatch, batch.batch);
    const scheduled = await t.run((ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    await t.mutation(internal.rateLimited.startBatch, batch.batch);
    expect(
      await t.run((ctx) =>
        ctx.db.system.query("_scheduled_functions").collect(),
      ),
    ).toEqual(scheduled);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].args).toEqual([
      { prompts: [{ id: ids[0], prompt: "current prompt" }] },
    ]);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(
      await t.run((ctx) => ctx.db.get("llmRequests", ids[1])),
    ).toMatchObject({ response: "already done" });
  });

  test("claims every request once when one transaction's requests span batches", async () => {
    const t = initConvexTest();
    // 11 requests in one transaction — one commit timestamp, split by
    // BATCH_SIZE (5). These are claimed (patched to "started"), not deleted, so
    // the cursor has to resume inside the tie without skipping the rest of it.
    await t.run(async (ctx) => {
      for (let i = 0; i < 11; i++) {
        await ctx.db.insert("llmRequests", {
          prompt: `bulk ${i}`,
          inputTokens: 100,
          state: "pending",
          updatedAt: ctx.db.vars.commitTs,
        });
      }
    });
    // submitRequest is what pings the worker.
    await t.mutation(api.rateLimited.submitRequest, {
      prompt: "last",
      inputTokens: 100,
    });

    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const requests = await t.query(api.rateLimited.listRequests, {});
    expect(requests).toHaveLength(12);
    expect(requests.every((r) => r.state === "finished")).toBe(true);
    expect(await t.query(api.rateLimited.stats, {})).toEqual({
      pending: 0,
      started: 0,
      finished: 12,
    });
  });

  test("a big batch that exceeds the token budget still completes", async () => {
    const t = initConvexTest();
    // 300k input tokens against a 200k/min budget forces a reservation wait.
    for (let i = 0; i < 30; i++) {
      await t.mutation(api.rateLimited.submitRequest, {
        prompt: `prompt ${i}`,
        inputTokens: 10_000,
      });
    }

    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const requests = await t.query(api.rateLimited.listRequests, {});
    expect(requests.every((r) => r.state === "finished")).toBe(true);
  });
});
