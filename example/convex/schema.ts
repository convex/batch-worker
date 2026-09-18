import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // A simple work queue: each row is one event to be summed.
  //
  // `insertedAt` is written as `ctx.db.vars.commitTs` and resolves, when the
  // writing mutation commits, to an int64 ordered by commit order. Indexed so
  // the worker can resume from the cursor it last returned instead of scanning
  // from the front of the table every batch.
  events: defineTable({
    value: v.number(),
    insertedAt: v.commitTs(),
  }).index("insertedAt", ["insertedAt"]),
  // A singleton holding the running total, updated by the worker.
  totals: defineTable({
    key: v.string(),
    total: v.number(),
    count: v.number(),
  }).index("key", ["key"]),

  // --- Rate-limited async LLM batches (see rateLimited.ts) ---
  llmRequests: defineTable({
    prompt: v.string(),
    inputTokens: v.number(),
    state: v.union(
      v.literal("pending"),
      v.literal("started"),
      v.literal("finished"),
    ),
    updatedAt: v.commitTs(),
    startedAt: v.optional(v.number()),
    response: v.optional(v.string()),
    outputTokens: v.optional(v.number()),
    // The index covers the state *and* the timestamp, so the scan for pending
    // requests can start from a cursor within the pending range.
  }).index("state_updatedAt", ["state", "updatedAt"]),

  // --- Serial denormalized-aggregate updates (see aggregates.ts) ---
  scoreEvents: defineTable({
    team: v.string(),
    points: v.number(),
    insertedAt: v.commitTs(),
  }).index("insertedAt", ["insertedAt"]),
  teamTotals: defineTable({ team: v.string(), total: v.number() }).index(
    "team",
    ["team"],
  ),

  // --- e2e performance harness (see e2e.ts / e2e.mjs) ---
  e2eEvents: defineTable({
    value: v.number(),
    updatedAt: v.commitTs(),
  }).index("updatedAt", ["updatedAt"]),
  // One row per processed batch, recording end-to-end latency.
  e2eSamples: defineTable({
    processedAt: v.number(),
    batchSize: v.number(),
    // ms from each event's enqueue (_creationTime) to when it was processed.
    oldestLatencyMs: v.number(),
    newestLatencyMs: v.number(),
  }),

  // Isolated fixtures for benchmark.mjs; each run cleans up its own rows.
  benchmarkItems: defineTable({
    runId: v.string(),
    value: v.number(),
    padding: v.string(),
    processed: v.boolean(),
    result: v.optional(v.number()),
  }).index("by_runId_processed", ["runId", "processed"]),
});
