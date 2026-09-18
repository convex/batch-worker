import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { initConvexTest } from "./setup.test";
import { api, components, internal } from "./_generated/api";

describe("example worker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("processes a single event", async () => {
    const t = initConvexTest();
    await t.mutation(api.example.addEvent, { value: 5 });

    // Run the debounced loop (and everything it schedules) to completion.
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const totals = await t.query(api.example.getTotals, {});
    expect(totals).toEqual({ total: 5, count: 1, pending: 0 });
  });

  test("re-fetches changed events and skips deleted or already processed candidates", async () => {
    const t = initConvexTest();
    const ids = await t.run(async (ctx) => {
      const first = await ctx.db.insert("events", {
        value: 1,
        insertedAt: ctx.db.vars.commitTs,
      });
      const second = await ctx.db.insert("events", {
        value: 2,
        insertedAt: ctx.db.vars.commitTs,
      });
      return [first, second];
    });
    const batch = await t.query(internal.example.getBatch, { name: "events" });
    if (!batch.batch) throw new Error("Expected work");
    // Explicitly create the gap between the query and mutation snapshots.
    await t.run(async (ctx) => {
      await ctx.db.patch("events", ids[0], { value: 10 });
      await ctx.db.delete("events", ids[1]);
    });
    await t.mutation(internal.example.processBatch, batch.batch);
    await t.mutation(internal.example.processBatch, batch.batch);
    expect(await t.query(api.example.getTotals, {})).toEqual({
      total: 10,
      count: 1,
      pending: 0,
    });
  });

  test("batches many events across iterations", async () => {
    const t = initConvexTest();
    // 25 events => 3 batches of 10/10/5.
    let expected = 0;
    for (let i = 1; i <= 25; i++) {
      expected += i;
      await t.mutation(api.example.addEvent, { value: i });
    }

    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const totals = await t.query(api.example.getTotals, {});
    expect(totals).toEqual({ total: expected, count: 25, pending: 0 });
  });

  test("worker goes idle after draining the queue", async () => {
    const t = initConvexTest();
    await t.mutation(api.example.addEvent, { value: 1 });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const status = await t.query(api.example.workerStatus, {});
    expect(status?.kind).toBe("idle");

    const totals = await t.query(api.example.getTotals, {});
    expect(totals.count).toBe(1);
  });

  test("re-runs when work is added after going idle", async () => {
    const t = initConvexTest();
    await t.mutation(api.example.addEvent, { value: 10 });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await t.query(api.example.getTotals, {})).total).toBe(10);

    // Now idle; add more and confirm it kicks again.
    await t.mutation(api.example.addEvent, { value: 7 });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await t.query(api.example.getTotals, {})).toEqual({
      total: 17,
      count: 2,
      pending: 0,
    });
  });

  test("strands nothing when a batch boundary lands inside one transaction", async () => {
    const t = initConvexTest();
    // Every row a single mutation inserts shares one commit timestamp, so these
    // 25 events are one tie and BATCH_SIZE (10) splits it. That's what makes the
    // cursor inclusive (`gte`): `gt` would skip the rest of the tie.
    await t.run(async (ctx) => {
      for (let i = 0; i < 25; i++) {
        await ctx.db.insert("events", {
          value: 2,
          insertedAt: ctx.db.vars.commitTs,
        });
      }
    });
    // addEvent both inserts and pings, so this also wakes the loop.
    await t.mutation(api.example.addEvent, { value: 5 });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await t.query(api.example.getTotals, {})).toEqual({
      total: 55,
      count: 26,
      pending: 0,
    });
    // `pending` counts from the cursor, so check the table itself for rows the
    // cursor might have skipped past.
    const left = await t.run((ctx) => ctx.db.query("events").collect());
    expect(left).toEqual([]);
  });

  test("advances the cursor to the last event it processed", async () => {
    const t = initConvexTest();
    await t.mutation(api.example.addEvent, { value: 1 });
    await t.mutation(api.example.addEvent, { value: 2 });
    // The loop hasn't run yet, so the events (and their resolved timestamps)
    // are still there to compare against.
    const inserted = await t.run((ctx) =>
      ctx.db.query("events").withIndex("insertedAt").collect(),
    );
    const lastInsertedAt = inserted.at(-1)!.insertedAt;
    expect(typeof lastInsertedAt).toBe("bigint");

    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const cursor = await t.run((ctx) =>
      ctx.runQuery(components.batchWorker.lib.getCursor, { name: "events" }),
    );
    expect(cursor).toBe(lastInsertedAt);
  });

  test("leaves events behind the cursor alone", async () => {
    const t = initConvexTest();
    // The cursor lives on the worker, so it has to exist before we can park it.
    await t.mutation(api.example.addEvent, { value: 1 });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    // Insert an event without pinging, so the loop doesn't pick it up.
    await t.run(async (ctx) => {
      await ctx.db.insert("events", {
        value: 100,
        insertedAt: ctx.db.vars.commitTs,
      });
    });
    // Park the cursor past that event, as if a previous run had processed it.
    // (Its timestamp only resolves once the inserting transaction commits, so
    // this has to be a second transaction.)
    await t.run(async (ctx) => {
      const [old] = await ctx.db
        .query("events")
        .withIndex("insertedAt")
        .collect();
      await ctx.runMutation(components.batchWorker.lib.setCursor, {
        name: "events",
        cursor: (old.insertedAt as bigint) + 1n,
      });
    });

    await t.mutation(api.example.addEvent, { value: 5 });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    // Only the new event was summed — the scan really does start at the cursor.
    expect(await t.query(api.example.getTotals, {})).toEqual({
      total: 6,
      count: 2,
      pending: 0,
    });
    const left = await t.run((ctx) => ctx.db.query("events").collect());
    expect(left.map((e) => e.value)).toEqual([100]);
  });
});
