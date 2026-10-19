import { Workpool } from "@convex-dev/workpool";
import { defineBatchWorkerValidators, ping } from "@convex-dev/batch-worker";
import { v } from "convex/values";
import { components, internal } from "./_generated/api.js";
import { internalMutation, internalQuery } from "./_generated/server.js";

// Console markers instrument the real query path without adding per-iteration
// writes or turning an idle poll into a batch mutation. The Node runner reads
// successful execution logs and retains their execution timestamps as well.
const validators = defineBatchWorkerValidators({
  cursor: v.number(),
  batch: { iteration: v.number() },
});

export const start = internalMutation({
  args: {
    runId: v.string(),
    backend: v.union(v.literal("scheduler"), v.literal("workpool")),
    mode: v.union(v.literal("busy"), v.literal("poll")),
    durationMs: v.number(),
    pollIntervalMs: v.number(),
    workers: v.number(),
    maxParallelism: v.number(),
  },
  returns: v.object({
    names: v.array(v.string()),
    startedAt: v.number(),
    deadline: v.number(),
  }),
  handler: async (ctx, args) => {
    if (
      !Number.isFinite(args.durationMs) ||
      args.durationMs < 1000 ||
      args.durationMs > 60_000 ||
      !Number.isInteger(args.workers) ||
      args.workers < 1 ||
      args.workers > 10 ||
      !Number.isInteger(args.maxParallelism) ||
      args.maxParallelism < 1 ||
      args.maxParallelism > 10 ||
      !Number.isFinite(args.pollIntervalMs) ||
      args.pollIntervalMs < 0 ||
      args.pollIntervalMs > 1000
    ) {
      throw new Error(
        "Benchmark limits: 1–60s, 1–10 workers/slots, 0–1000ms polls",
      );
    }
    const startedAt = Date.now();
    const deadline = startedAt + args.durationMs;
    const pool = new Workpool(components.benchmarkPool, {
      maxParallelism: args.maxParallelism,
      logLevel: "ERROR",
    });
    const names: string[] = [];
    for (let i = 0; i < args.workers; i++) {
      // Reuse names between trials to bound benchmark metadata growth.
      const name = `benchmark:${args.backend}:${args.mode}:${args.pollIntervalMs}:${i}`;
      names.push(name);
      const previous = await ctx.db
        .query("executionBenchmarks")
        .withIndex("name", (q) => q.eq("name", name))
        .unique();
      const config = {
        name,
        runId: args.runId,
        mode: args.mode,
        startedAt,
        deadline,
        pollIntervalMs: args.pollIntervalMs,
      };
      if (previous)
        await ctx.db.replace("executionBenchmarks", previous._id, config);
      else await ctx.db.insert("executionBenchmarks", config);
      await ctx.runMutation(components.batchWorker.lib.stop, { name });
      await ping(ctx, components.batchWorker, {
        name,
        workQuery: internal.executionBenchmark.getBatch,
        workerMutation: internal.executionBenchmark.processBatch,
        ...(args.backend === "workpool" ? { workpool: pool } : {}),
      });
      await ctx.runMutation(components.batchWorker.lib.setCursor, { name });
      await ctx.runMutation(components.batchWorker.lib.start, { name });
    }
    return { names, startedAt, deadline };
  },
});

export const getBatch = internalQuery({
  args: validators.vQueryArgs,
  returns: validators.vQueryReturns,
  handler: async (ctx, { name, cursor }) => {
    const config = await ctx.db
      .query("executionBenchmarks")
      .withIndex("name", (q) => q.eq("name", name))
      .unique();
    if (!config || Date.now() >= config.deadline || (cursor ?? 0) >= 10_000) {
      return { kind: "idle" as const, cooldownMs: 0 };
    }
    const phase =
      config.mode === "poll"
        ? cursor === undefined
          ? "bootstrap"
          : "poll"
        : "iteration";
    console.log(
      "BATCH_BENCH",
      JSON.stringify({
        runId: config.runId,
        name,
        phase,
        atMs: Date.now(),
        iteration: cursor ?? 0,
      }),
    );
    if (phase === "poll") {
      return {
        kind: "idle" as const,
        cooldownMs: config.deadline - config.startedAt + 1000,
        pollIntervalMs: config.pollIntervalMs,
      };
    }
    // A single bootstrap batch starts the cooldown clock for polling trials.
    return { batch: { iteration: cursor ?? 0 }, cursor: (cursor ?? 0) + 1 };
  },
});

export const processBatch = internalMutation({
  args: validators.vMutationArgs,
  returns: validators.vMutationReturns,
  handler: async () => null,
});

export const status = internalQuery({
  args: { names: v.array(v.string()) },
  returns: v.boolean(),
  handler: async (ctx, { names }) => {
    for (const name of names) {
      const state = await ctx.runQuery(components.batchWorker.lib.status, {
        name,
      });
      if (state?.kind === "running") return false;
    }
    return true;
  },
});

export const stop = internalMutation({
  args: { names: v.array(v.string()) },
  returns: v.null(),
  handler: async (ctx, { names }) => {
    for (const name of names)
      await ctx.runMutation(components.batchWorker.lib.stop, { name });
    return null;
  },
});
