/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  anyApi,
  componentsGeneric,
  defineSchema,
  defineTable,
  internalMutationGeneric,
  internalQueryGeneric,
  type ApiFromModules,
  type DataModelFromSchemaDefinition,
  type QueryBuilder,
  type MutationBuilder,
} from "convex/server";
import { v } from "convex/values";
import { convexTest } from "convex-test";
import {
  Workpool,
  type WorkpoolComponent,
  type WorkId,
} from "@convex-dev/workpool";
import workpoolTest from "@convex-dev/workpool/test";
import batchWorkerTest from "../test.js";
import { defineBatchWorkerValidators, ping } from "./index.js";
import type { ComponentApi } from "../component/_generated/component.js";
import type { Doc } from "../component/_generated/dataModel.js";
import type { internal as batchInternal } from "../component/_generated/api.js";

const schema = defineSchema({
  items: defineTable({ name: v.string(), seq: v.int64() }).index("name_seq", [
    "name",
    "seq",
  ]),
  batches: defineTable({ name: v.string(), seqs: v.array(v.int64()) }),
  behavior: defineTable({
    name: v.string(),
    failQuery: v.optional(v.boolean()),
    failMutation: v.optional(v.boolean()),
    timeoutMs: v.optional(v.number()),
    debounceMs: v.optional(v.number()),
  }).index("name", ["name"]),
});
type DataModel = DataModelFromSchemaDefinition<typeof schema>;
const query = internalQueryGeneric as QueryBuilder<DataModel, "internal">;
const mutation = internalMutationGeneric as MutationBuilder<
  DataModel,
  "internal"
>;
const validators = defineBatchWorkerValidators({
  cursor: v.int64(),
  batch: {
    name: v.string(),
    items: v.array(v.object({ id: v.id("items"), seq: v.int64() })),
  },
});

export const getBatch = query({
  args: validators.vQueryArgs,
  returns: validators.vQueryReturns,
  handler: async (ctx, { name, cursor }) => {
    const behavior = await ctx.db
      .query("behavior")
      .withIndex("name", (q) => q.eq("name", name))
      .unique();
    if (behavior?.failQuery) throw new Error("query failure");
    const items = await ctx.db
      .query("items")
      .withIndex("name_seq", (q) => q.eq("name", name).gte("seq", cursor ?? 0n))
      .take(3);
    if (!items.length)
      return {
        kind: "idle" as const,
        cooldownMs: 0,
        ...(behavior?.timeoutMs !== undefined
          ? { timeoutMs: behavior.timeoutMs }
          : {}),
      };
    return {
      batch: {
        name,
        items: items.map((item) => ({ id: item._id, seq: item.seq as bigint })),
      },
      cursor: (items.at(-1)!.seq as bigint) + 1n,
    };
  },
});
export const processBatch = mutation({
  args: validators.vMutationArgs,
  returns: validators.vMutationReturns,
  handler: async (ctx, { name, items }) => {
    await ctx.db.insert("batches", {
      name,
      seqs: items.map((item) => item.seq),
    });
    for (const item of items) await ctx.db.delete("items", item.id);
    const behavior = await ctx.db
      .query("behavior")
      .withIndex("name", (q) => q.eq("name", name))
      .unique();
    if (behavior?.failMutation)
      throw new Error("mutation failure after writes");
    return behavior?.debounceMs !== undefined
      ? { debounceMs: behavior.debounceMs }
      : null;
  },
});
const testApi = (
  anyApi as unknown as ApiFromModules<{
    "workpool.test": {
      getBatch: typeof getBatch;
      processBatch: typeof processBatch;
    };
  }>
)["workpool.test"];

// Test-only inspection functions mounted inside the actual component namespaces.
const workerQueries = {
  state: internalQueryGeneric({
    args: { name: v.string() },
    handler: async (ctx, { name }) => {
      const worker = (await ctx.db
        .query("workers")
        .withIndex("name", (q) => q.eq("name", name))
        .unique()) as Doc<"workers"> | null;
      const state =
        worker &&
        ((await ctx.db.get(
          "workerState",
          worker.stateId,
        )) as Doc<"workerState"> | null);
      return { worker, state };
    },
  }),
};
const poolQueries = {
  state: internalQueryGeneric({
    args: {},
    handler: async (ctx) => ({
      work: await ctx.db.query("work").take(100),
      state: await ctx.db.query("internalState").unique(),
      globals: await ctx.db.query("globals").unique(),
    }),
  }),
};
const components = componentsGeneric() as unknown as {
  batchWorker: ComponentApi &
    typeof batchInternal &
    ApiFromModules<{ _test: typeof workerQueries }>;
  pool: WorkpoolComponent & ApiFromModules<{ _test: typeof poolQueries }>;
  otherPool: WorkpoolComponent;
};

function setup() {
  const t = convexTest(schema, {
    ...import.meta.glob("./**/*.ts"),
    "./workpool.test.ts": async () => ({ getBatch, processBatch }),
  });
  t.registerComponent("batchWorker", batchWorkerTest.schema, {
    ...batchWorkerTest.modules,
    "./component/_test.ts": async () => workerQueries,
  });
  for (const name of ["pool", "otherPool"]) {
    t.registerComponent(name, workpoolTest.schema, {
      ...workpoolTest.modules,
      "./component/_test.ts": async () => poolQueries,
    });
    batchWorkerTest.register(t, `${name}/batchWorker`);
  }
  // Omit maxParallelism so tests can pause/resume the pool dynamically.
  const pool = new Workpool(components.pool, { logLevel: "ERROR" });
  const register = (
    name = "user",
    workpool: Workpool | undefined = pool,
    debounceMs = 0,
  ) =>
    t.mutation((ctx) =>
      ping(ctx, components.batchWorker, {
        name,
        workQuery: testApi.getBatch,
        workerMutation: testApi.processBatch,
        config: { debounceMs, monitorLagMs: 10_000 },
        ...(workpool ? { workpool } : {}),
      }),
    );
  const seed = (name: string, seqs: bigint[]) =>
    t.mutation(async (ctx) => {
      for (const seq of seqs) await ctx.db.insert("items", { name, seq });
    });
  const state = (name = "user") =>
    t.query(components.batchWorker._test.state, { name });
  const capacity = (maxParallelism: number) =>
    t.mutation(components.pool.config.update, { maxParallelism });
  const batches = () =>
    t.query(async (ctx) =>
      (await ctx.db.query("batches").take(100)).map((b) => ({
        name: b.name,
        seqs: b.seqs,
      })),
    );
  // Advance individual scheduler waves so we can inspect admission and failure
  // before a delayed retry runs. convex-test serializes mutations, so checking
  // Workpool's admitted set is more meaningful than timing handler overlap.
  const until = async (condition: () => Promise<boolean>) => {
    for (let i = 0; i < 150; i++) {
      if (await condition()) return;
      vi.advanceTimersToNextTimer();
      await t.finishInProgressScheduledFunctions();
    }
    throw new Error("condition did not become true");
  };
  const drain = () => t.finishAllScheduledFunctions(vi.runAllTimers);
  return { t, pool, register, seed, state, capacity, batches, until, drain };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-09T00:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("Workpool execution", () => {
  test("queues one lazy continuation per worker and caps shared admission", async () => {
    const s = setup();
    await s.capacity(0);
    for (const name of ["alice", "bob", "carol"]) {
      await s.seed(name, [0n]);
      await s.register(name);
      await s.register(name);
      await s.seed(name, [1n, 2n, 3n]);
    }
    const queued = await s.t.query(components.pool._test.state, {});
    expect(queued.work).toHaveLength(3);
    expect(
      queued.work.every(
        (w) => Object.keys(w.fnArgs).sort().join() === "generation,name",
      ),
    ).toBe(true);
    expect(
      queued.work.every(
        (w) => w.onComplete.onStatusHandle.failed && !w.onComplete.fnHandle,
      ),
    ).toBe(true);
    expect(await s.batches()).toEqual([]);
    const before = await s.state("alice");
    expect(before.state?.runnerId).toBeUndefined();
    expect(before.state?.monitorId).toBeUndefined();
    // Backlog older than the scheduler watchdog's threshold is healthy.
    vi.setSystemTime(Date.now() + 120_000);
    await s.register("alice");
    await s.t.mutation(components.batchWorker.monitor.monitor, {
      name: "alice",
    });
    expect((await s.state("alice")).state?.generation).toBe(
      before.state?.generation,
    );

    await s.capacity(2);
    await s.until(
      async () =>
        (await s.t.query(components.pool._test.state, {})).state?.running
          .length === 2,
    );
    expect(
      (await s.t.query(components.pool._test.state, {})).state.running,
    ).toHaveLength(2);
    await s.drain();
    for (const name of ["alice", "bob", "carol"]) {
      expect(
        (await s.batches()).filter((b) => b.name === name).map((b) => b.seqs),
      ).toEqual([[0n, 1n, 2n], [3n]]);
      expect((await s.state(name)).worker?.status.kind).toBe("idle");
      expect((await s.state(name)).state?.workpoolJob).toBeUndefined();
    }
  });

  test.each(["failQuery", "failMutation"] as const)(
    "recovers %s with delayed retry and atomic cursor/batch writes",
    async (failure) => {
      const s = setup();
      const behavior = await s.t.mutation((ctx) =>
        ctx.db.insert("behavior", { name: "user", [failure]: true }),
      );
      await s.seed("user", [0n, 1n]);
      await s.register();
      const before = (await s.state()).state!;
      await s.until(
        async () => (await s.state()).state!.generation > before.generation,
      );
      const after = (await s.state()).state!;
      expect(after.cursor).toBeUndefined();
      expect(after.workpoolJob!.runAt).toBeGreaterThanOrEqual(
        Date.now() + 10_000,
      );
      expect(after.monitorId).toBeUndefined();
      expect(await s.batches()).toEqual([]);
      expect(
        await s.t.query((ctx) => ctx.db.query("items").take(10)),
      ).toHaveLength(2);
      // Duplicate notifications for the failed generation cannot create jobs.
      await s.t.mutation(components.batchWorker.workpool.onFailure, {
        workId: before.workpoolJob!.id,
        context: { name: "user", generation: before.generation },
        result: { kind: "failed", error: "duplicate" },
      });
      expect((await s.state()).state?.generation).toBe(after.generation);
      await s.t.mutation((ctx) =>
        ctx.db.patch("behavior", behavior, { [failure]: false }),
      );
      await s.drain();
      expect(await s.batches()).toEqual([{ name: "user", seqs: [0n, 1n] }]);
      expect((await s.state()).state?.cursor).toBe(2n);
    },
  );

  test("stop invalidates an admitted mutation and late failures across start", async () => {
    const s = setup();
    await s.seed("user", [0n]);
    await s.register();
    const before = (await s.state()).state!;
    await s.until(
      async () =>
        (await s.t.query(components.pool._test.state, {})).state?.running
          .length === 1,
    );
    await s.t.mutation(components.batchWorker.lib.stop, { name: "user" });
    await s.register(); // ping cannot resume a stopped worker
    expect((await s.state()).worker?.status.kind).toBe("stopped");
    await s.drain(); // admitted wrapper may run, but the batch must not
    expect(await s.batches()).toEqual([]);
    await s.t.mutation(components.batchWorker.lib.start, { name: "user" });
    const restarted = (await s.state()).state!;
    await s.t.mutation(components.batchWorker.workpool.onFailure, {
      workId: before.workpoolJob!.id,
      context: { name: "user", generation: before.generation },
      result: { kind: "failed", error: "late failure" },
    });
    expect((await s.state()).state?.generation).toBe(restarted.generation);
    await s.drain();
    expect(await s.batches()).toEqual([{ name: "user", seqs: [0n] }]);
  });

  test("interrupts idle timeouts but keeps imminent pooled wakeups", async () => {
    const s = setup();
    const behavior = await s.t.mutation((ctx) =>
      ctx.db.insert("behavior", { name: "user", timeoutMs: 30_000 }),
    );
    await s.register();
    await s.until(async () => (await s.state()).worker?.status.kind === "idle");
    const waiting = (await s.state()).state!;
    await s.seed("user", [0n]);
    await s.register();
    expect((await s.state()).state!.workpoolJob!.id).not.toBe(
      waiting.workpoolJob!.id,
    );
    await s.until(async () => (await s.state()).worker?.status.kind === "idle");
    const imminent = (await s.state()).state!;
    vi.setSystemTime(imminent.workpoolJob!.runAt - 500);
    await s.register();
    expect((await s.state()).state!.workpoolJob!.id).toBe(
      imminent.workpoolJob!.id,
    );
    await s.t.mutation((ctx) =>
      ctx.db.patch("behavior", behavior, { timeoutMs: undefined }),
    );
    await s.drain();
    expect(await s.batches()).toEqual([{ name: "user", seqs: [0n] }]);
  });

  test("keeps debounce windows when pinged", async () => {
    const s = setup();
    await s.t.mutation((ctx) =>
      ctx.db.insert("behavior", { name: "user", debounceMs: 20_000 }),
    );
    await s.seed("user", [0n, 1n, 2n, 3n]);
    await s.register("user", s.pool, 5000);
    const initial = (await s.state()).state!;
    await s.register("user", s.pool, 5000);
    expect((await s.state()).state?.workpoolJob).toEqual(initial.workpoolJob);
    await s.until(async () => (await s.batches()).length === 1);
    const next = (await s.state()).state!;
    await s.register("user", s.pool, 5000);
    expect((await s.state()).state?.workpoolJob).toEqual(next.workpoolJob);
    expect(next.workpoolJob!.runAt).toBeGreaterThanOrEqual(Date.now() + 20_000);
    await s.drain();
    expect((await s.batches()).map((b) => b.seqs)).toEqual([
      [0n, 1n, 2n],
      [3n],
    ]);
  });

  test("recovers a failed timeout wake while the worker is marked idle", async () => {
    const s = setup();
    const behavior = await s.t.mutation((ctx) =>
      ctx.db.insert("behavior", { name: "user", timeoutMs: 30_000 }),
    );
    await s.register();
    await s.until(async () => (await s.state()).worker?.status.kind === "idle");
    const waiting = (await s.state()).state!;
    await s.t.mutation((ctx) =>
      ctx.db.patch("behavior", behavior, { failQuery: true }),
    );
    await s.until(
      async () => (await s.state()).state!.generation > waiting.generation,
    );
    const recovering = await s.state();
    expect(recovering.worker?.status.kind).toBe("running");
    expect(recovering.state?.monitorId).toBeUndefined();
    expect(recovering.state!.workpoolJob!.runAt).toBeGreaterThanOrEqual(
      Date.now() + 10_000,
    );
    await s.t.mutation((ctx) =>
      ctx.db.patch("behavior", behavior, {
        failQuery: false,
        timeoutMs: undefined,
      }),
    );
    await s.seed("user", [0n]);
    await s.drain();
    expect(await s.batches()).toEqual([{ name: "user", seqs: [0n] }]);
  });

  test("moves between pools and the scheduler without losing the cursor", async () => {
    const s = setup();
    await s.capacity(0);
    await s.seed("user", [0n, 1n, 2n, 3n]);
    await s.register();
    const first = (await s.state()).state!;
    const otherPool = new Workpool(components.otherPool, {
      maxParallelism: 0,
      logLevel: "ERROR",
    });
    await s.register("user", otherPool);
    const moved = (await s.state()).state!;
    expect(moved.workpoolJob!.cancel).not.toBe(first.workpoolJob!.cancel);
    // Explicitly omit the pool to switch to scheduler execution.
    await s.t.mutation((ctx) =>
      ping(ctx, components.batchWorker, {
        name: "user",
        workQuery: testApi.getBatch,
        workerMutation: testApi.processBatch,
        config: { debounceMs: 0 },
      }),
    );
    const scheduled = (await s.state()).state!;
    expect(scheduled.workpoolJob).toBeUndefined();
    expect(scheduled.runnerId).toBeDefined();
    expect(scheduled.monitorId).toBeDefined();
    await s.until(async () => (await s.batches()).length === 1);
    await s.register();
    const pooled = (await s.state()).state!;
    expect(pooled.cursor).toBe(3n);
    expect(pooled.monitorId).toBeUndefined();
    await s.capacity(1);
    await s.drain();
    expect((await s.batches()).map((b) => b.seqs)).toEqual([
      [0n, 1n, 2n],
      [3n],
    ]);
    expect(
      await s.t.query((ctx) =>
        s.pool.status(ctx, first.workpoolJob!.id as WorkId),
      ),
    ).toEqual({ state: "finished" });
  });

  test("direct Workpool cancellation requires manual kick", async () => {
    const s = setup();
    await s.capacity(0);
    await s.seed("user", [0n]);
    await s.register();
    const before = (await s.state()).state!;
    await s.t.mutation((ctx) =>
      s.pool.cancel(ctx, before.workpoolJob!.id as WorkId),
    );
    await s.drain();
    expect((await s.state()).state?.generation).toBe(before.generation);
    expect(await s.batches()).toEqual([]);
    await s.t.mutation(components.batchWorker.lib.kick, { name: "user" });
    await s.capacity(1);
    await s.drain();
    expect(await s.batches()).toEqual([{ name: "user", seqs: [0n] }]);
  });
});
