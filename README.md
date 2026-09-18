# Batch Worker

[![npm version](https://badge.fury.io/js/@convex-dev%2Fbatch-worker.svg)](https://badge.fury.io/js/@convex-dev/batch-worker)
[![Convex Component](https://www.convex.dev/components/badge/batch-worker)](https://www.convex.dev/components/batch-worker)

<!-- START: Include on https://convex.dev/components -->

Process batches of work in your own tables by defining workers that loop
automatically, with scheduling, debouncing, and recovery built in.

You bring two functions:

- A **work query** that returns the next batch of work, or explicitly go idle.
- A **worker mutation** that processes that batch.

After inserting work, call `ping(...)`. The component takes care of the rest:

- Runs exactly one loop at a time per named Worker.
- Supports debouncing bursts so they batch together.
- Keeps the loop "warm" with a short polling cooldown so a trickle of new work
  does not thrash the running status.
- Uses snapshot reads while draining so concurrent inserts don't cause OCC
  retries, and confirms with a real read before going idle so nothing is lost.
- Goes idle when the queue drains, and restarts automatically the next time you
  ping.
- Monitors the loop and **restarts it if it ever dies** (e.g. an unexpected
  error), logging the failure so you can alert on it.

This is the pattern behind components like
[Workpool](https://github.com/get-convex/workpool), extracted so you can build
your own "process a queue" components.

Found a bug? Feature request?
[File it here](https://github.com/get-convex/batch-worker/issues).

## Installation

Create a `convex.config.ts` file in your app's `convex/` folder and install the
component by calling `use`:

```ts
// convex/convex.config.ts
import { defineApp } from "convex/server";
import batchWorker from "@convex-dev/batch-worker/convex.config.js";

const app = defineApp();
app.use(batchWorker);

export default app;
```

For components, call `component.use(batchWorker)` in your component's
`convex.config.ts`.

## Usage

Insert work into your own table, then call `ping`. Provide a query that returns
the next batch or `idle`, and a mutation that processes it. To ensure that the
batch shape always matches between the query and the mutation, use
`defineBatchWorkerValidators` to obtain argument and return validators.

Alongside the batch, the query returns a **cursor** saying how far it got. The
component commits it with the batch and hands it back as `args.cursor` next
time, so each scan resumes where the last one stopped. See
[why that matters](#why-is-a-cursor-necessary).

```ts
import { v } from "convex/values";
import { defineBatchWorkerValidators, ping } from "@convex-dev/batch-worker";
import { components, internal } from "./_generated/api";
import { internalMutation, internalQuery, mutation } from "./_generated/server";

const BATCH_SIZE = 10;

// Insert work, then make sure the loop is running.
export const addEvent = mutation({
  args: { value: v.number() },
  handler: async (ctx, { value }) => {
    // `db.vars.commitTs` resolves at commit to an int64 ordered by commit
    // order — that's what makes it safe to use as a cursor. See below.
    await ctx.db.insert("events", { value, insertedAt: ctx.db.vars.commitTs });
    await ping(ctx, components.batchWorker, {
      name: "events", // distinct names give you independent queues
      workQuery: internal.example.getBatch,
      workerMutation: internal.example.processBatch,
    });
  },
});

const { vQueryArgs, vQueryReturns, vMutationArgs, vMutationReturns } =
  defineBatchWorkerValidators({ batch: { ids: v.array(v.id("events")) } });

// Return the next batch of work, or `idle` when there's nothing to do.
export const getBatch = internalQuery({
  args: vQueryArgs, // `name` lets one query serve many queues
  returns: vQueryReturns,
  handler: async (ctx, { cursor }) => {
    // Resume where the last batch stopped.
    const events = await ctx.db
      .query("events")
      .withIndex("insertedAt", (q) => q.gte("insertedAt", cursor ?? 0n))
      .take(BATCH_SIZE);
    if (events.length === 0) {
      return { kind: "idle" as const };
      // Or, if you know when the next item is due:
      // return { kind: "idle" as const, timeoutMs: 30_000 };
    }
    return {
      kind: "work" as const,
      batch: { ids: events.map((e) => e._id) },
      // Rows come back in commit order, so the last one is how far we got.
      cursor: events.at(-1)!.insertedAt,
    };
  },
});

// Process one batch.
export const processBatch = internalMutation({
  args: vMutationArgs,
  returns: vMutationReturns,
  handler: async (ctx, { ids }) => {
    for (const id of ids) {
      // Re-fetch if other mutations may edit or delete queued events.
      const event = await ctx.db.get("events", id);
      if (!event) continue; // deleted by another mutation
      // ... do the work (sum, schedule downstream jobs, etc.)

      // Important: clean up processed work to exclude it from the next query.
      await ctx.db.delete("events", id);
    }
    // Returning nothing re-runs the query for the next batch immediately.
  },
});
```

### Find work in the query, process it in the mutation

The Batch Worker splits up work into a query and mutation in order to isolate
reads which are likely to conflict from the processing of those documents. For
example, reading a range of documents to process while new documents are being
inserted.

- The **work query** runs as a snapshot read that takes **no read
  dependencies**. It can scan a queue (`.take(BATCH_SIZE)` over an index)
  alongside concurrent inserts.
- The **worker mutation** is a normal transaction: every read is tracked to
  detect write conflicts. Because of this, it's advised to keep range scans in
  the query and use point reads (`db.get`) in the mutation to catch conflicting
  writes to the specific documents processed without conflicting on the whole
  query's **range**.

In general, treat the work query and the worker mutation as **two separate
transactions**[^1]. In the future they may read from different database
snapshots, meaning they could have changed or been deleted between the query and
mutation. As such, it's best practice to return IDs from the query and
re-validate invariants in the mutation when processing data that might be
changed from other mutations. In the example above, for example, we fetch the
latest value and check that the event still exists.

If your batch data are not updated by other mutations, it's ok to pass values
directly between the query and mutation. Tip: document these assumptions.

```ts
// Mutation: re-validate data before applying effects.
for (const id of ids) {
  const row = await ctx.db.get("tasks", id);
  if (!row || row.state !== "pending") continue;
  await ctx.db.patch("tasks", id, { state: "started" });
  // Schedule work using the current row's values.
}
```

[^1]:
    The query may (in the future) read an older database snapshot than the
    mutation, though it will still read the writes of the previous round's
    mutation. If a batch deletes rows or marks them started, the next query will
    observe those changes to easily exclude that work from its results.

### Steering the loop dynamically

Your worker mutation may return `{ debounceMs }` to throttle the loop:

```ts
return {
  // Don't run again — and ignore pings — for at least this long (debounce).
  debounceMs: 30_000,
};
```

(This return value spaces out batches while the loop is running; the ping's
`config.debounceMs` below is the delay when waking from idle, so a burst of
inserts can accumulate into one batch.) A ping "missed" during a debounce is
harmless: when the debounce elapses, the loop always re-runs your work query, so
anything inserted meanwhile is picked up.

Similarly, when there's no work your query can return
`{ kind: "idle", timeoutMs }` to ensure it wakes up after some time even if
`ping` is not called. A ping still wakes it immediately.

```ts
return {
  kind: "idle",
  // Keep polling this long before transitioning to idle.
  cooldownMs: 10_000,
  // How often to poll while cooling down.
  pollIntervalMs: 250,
  // After cooling down, wake again after at most this long even if no ping
  // arrives. Measured from this query response, so re-run it each query if you
  // want it to track a fixed deadline. A ping still wakes it sooner.
  timeoutMs: 60_000,
};
```

### Ping

Ping ensures the worker is running.

Options:

- `name`: The name of the queue to ping. You can give each queue a distinct
  `name`. The name is passed to your query as `args.name`, so one query/mutation
  pair can serve many queues. Usually there is only one worker with a static
  name.
- `workQuery`: The query that returns the next batch of work, or `idle`.
- `workerMutation`: The mutation that processes a batch.
- `config`: Optional configuration for the worker. It's stored on the worker and
  refreshed when it changes.

```ts
await ping(ctx, components.batchWorker, {
  name: "events",
  workQuery: internal.example.getBatch,
  workerMutation: internal.example.processBatch,
  config: {
    // wait before the first batch so a burst accumulates
    debounceMs: 100,
  },
});
```

### The cursor

The component stores the cursor for you: whatever your work query returns
alongside a batch comes back as `args.cursor` on the next call. It's committed
in the same transaction as the batch, so if your worker mutation throws, the
cursor stays where it was and the next query attempt will see the old cursor.
You can also return it from the mutation if you don't know how much progress
will be made ahead of time
([see below](#adjusting-the-cursor-from-the-worker-mutation)).

The default cursor type is a
[commit timestamp](https://docs.convex.dev/database/advanced/commit-timestamp)
(Convex ≥ 1.43), which avoids having to handle out-of-order commits. Add a
`v.commitTs()` field to the table the worker scans, index it, and write
`ctx.db.vars.commitTs` to it on every insert or patch:

```ts
// convex/schema.ts
myWork: defineTable({
  updatedAt: v.commitTs(), // resolves at commit to an int64 in commit order
  ...fields
}).index("updatedAt", ["updatedAt"]),
```

```ts
await ctx.db.insert("myWork", { updatedAt: ctx.db.vars.commitTs, ... });
await ctx.db.patch("myWork", id, { updatedAt: ctx.db.vars.commitTs, ... });
```

Tip: if you're scanning documents inserted in the past 5 minutes, do **not** use
`_creationTime`. It's assigned when a mutation _starts_, so a row inserted by a
slow mutation can land _behind_ rows the worker has already queried, violating
cursor invariants.

**Scan commit timestamps with `gte`.** Everything inserted in a single mutation
shares one commit timestamp, so a query scanning a batch of work can end in the
middle of such a tie. The next scan should then continue at the same commitTs
that it ended on. Note: this implies that you have another mechanism to avoid
dual-processing documents. If this isn't possible, see the next section on other
cursor types.

Alternatively, you could ensure that you process everything at a given commitTs
together by reading the remaining documents from that shared timestamp. So long
as you know it will all fit into a single query, this provides the extra benefit
of having work committed together to be processed together, which can have
consistency benefits. See
[the aggregate example](./example/convex/aggregates.ts).

#### Other cursor types

The cursor can be any Convex value, for instance a `streams` cursor from
`convex-helpers`, to capture a specific index position
`[commitTs, _creationTime, _id]` so you know exactly where you left off.

You can customize the `cursor` type with `defineBatchWorkerValidators`:

```ts
const { vQueryArgs, vQueryReturns, vMutationArgs, vMutationReturns } =
  defineBatchWorkerValidators({
    batch: { ids: v.array(v.id("myWork")) },
    cursor: v.string(),
  });
```

#### Adjusting the cursor from the worker mutation

The worker mutation can return a `cursor` that overrides the query's. Use it
when the batch made partial progress and you can work out how far it got, e.g.
from a per-item timestamp carried in the batch:

```ts
return { cursor: lastProcessed.updatedAt };
```

If it is not returned, it will defer to the cursor returned by the work query,
or keep the old value if none was returned. Note: if the cursor does not advance
and you did not update anything the query read, you may end up in an infinite
loop.

#### Reading and resetting the cursor

The work query receives the cursor in its args. To read it elsewhere, say from a
query counting pending work, call the component's `getCursor` function:

```ts
const cursor = await ctx.runQuery(components.batchWorker.lib.getCursor, {
  name: "events",
});
```

To overwrite it, call `lib.setCursor` with a new value. To clear it, call
`lib.setCursor` with no value. Use it sparingly, e.g. for migrations and
recovery. The loop writes that document every iteration, so a call made while
the worker is busy is liable to conflict. Note: it throws if the worker doesn't
exist yet (if `ping` hasn't been called).

#### Why is a cursor necessary?

The reason to track a cursor is because of a technical nuance of how Convex
currently tracks document changes. Internally, Convex stores previous versions
of documents in indexes for some time (~5 minutes, liable to change). Old values
will not be returned in results to JS, but it can slow down queries if they have
to scan and discard thousands of these entries.

In the simple example above, a `.take(BATCH_SIZE)` from the front of a table
followed by deleting all of those documents results in the beinning of the
table's index to be full of deleted documents, which the next query then scans
before reaching the next batch of work.

The solution is to keep a cursor to track your progress, and make your next
query starting at the cursor, allowing it to skip over the region of the index
full of previous versions or previously-handled work.

[See this video for more details](https://youtu.be/pHrxmSjxLg8).

### Use Case: Updating denormalized aggregates

To keep a denormalized aggregate (like a count or sum) up to date, you can use a
BatchWorker to process updates in the background, avoiding write conflicts.

For a full runnable example, see
[aggregates.ts](./example/convex/aggregates.ts).

Note: this pattern means that the aggregate document does not immediately
reflect the changes, so you need to be ok with slightly stale data when reading
the value. If you need the fully-up-to-date value, you have a couple options:

1. Start out by updating the value immediately and revisit a lazy approach
   if/when it turns out to be a real scaling issue. Convex already retries
   database conflicts a number of times, so you may be fine with the simpler
   approach.
2. Read all the updates and combine them with the stale value dynamically. When
   done from a query, it will stay consistent and reactive. Downside: it may
   require reading a lot of updates.
3. Use something like the Sharded Counter component, which parallelizes writes
   to a fixed number of documents, and reads all of the shards for the count.
   This is immediately consistent, but requires reading every shard, and needs
   to be manually tuned to avoid conflicts.

### Use Case: Batching work with actions

The worker mutation is a transaction, so it can't call external APIs itself. To
batch work that requires `fetch`, for example calling an LLM or hitting a
third-party API, have the worker mutation _claim_ a batch: the query returns
candidates to process, have the mutation validate those rows, mark them as
"started", then enqueue the batch in a Workpool. The next round's query skips
the claimed work. The action does the work and calls a mutation to commit the
results back.

Full working code is in [rateLimited.ts](./example/convex/rateLimited.ts). It
also rate-limits the batches, covered next.

Tip: if you use a Workpool, you can configure retries on the action, and commit
the results or handle any error in the `onComplete` handler, which has the nice
property of being called exactly once. Pass through information about the batch
in the `context` for the `onComplete` handler so you can update them even in the
case of failure. It will also help you manage parallelism of async work, so
live-site requests aren't impacted by background workloads.

### Rate limiting strategy

You can use Batch Worker with the
[Rate Limiter component](https://www.convex.dev/components/rate-limiter) to
bound how fast the loop does work, for example to respect an external API limit.

Full working code is in [rateLimited.ts](./example/convex/rateLimited.ts).

Tips for rate-limiting LLM calls:

- Use the rate limiter's **reserve** functionality to schedule work to happen in
  the future if there is not enough capacity now. It avoids the trial and error
  of checking a limit in a loop. Instead of rejecting, it reserves that capacity
  and instructs when the request will be valid with a `retryAfter` value. After
  waiting that duration, you make the request without checking the rate limit
  again.
- Use `retryAfter` two ways — to schedule the call for when you're actually
  allowed to make it, and as `debounceMs` to delay assembling the next batch.
- The simplest version of this is to use `rateLimiter.check(ctx, name)` to
  determine any necessary delay to account for previous requests, then consume
  the limit based on the full usage using
  `rateLimiter.limit(ctx, name, { count: totalTokens, reserve: true })` after
  the request completes.
- You can use the previous LLM response to get an accurate token count of the
  previous request and combine it with an estimate for the current request as a
  basis for estimating token usage.
- For more accurate tracking, you can reserve capacity before the request based
  on **input** token estimations, then account for the **output** tokens
  afterwards, making a call with `reserve: true` from both places.
- Consuming a rate limit after the request is a good trade-off for APIs that
  have some grace around bursts of requests, and where you don't know the full
  usage up-front. The post-request adjustment serves to delay future requests so
  that your overall usage matches the rate limit, even if you temporarily go
  above it.
- If you'd rather delay the worker mutation until there's enough capacity, the
  work query can call `rateLimiter.check(...)` (read-only) and return
  `{ kind: "idle", timeoutMs: retryAfter }` instead. This has the benefit of
  letting more work accumulate for a batched request, or allowing skipping work
  that gets canceled in the mean time.

### Failure handling

If your work query or worker mutation throws, the loop dies and the liveness
monitor restarts it after ~`monitorLagMs` (configurable via `ping`). The failed
mutation's writes and any cursor changes roll back, so the query retries from
the previous cursor. As a result, one poison item that causes a mutation to
always throws can wedge the worker. Tip: for work that can fail per item, catch
errors inside the worker mutation, and isolate bad docs in a table ("dead letter
queue") for async debugging.

This is a low-level primitive relative to components like Workpool or Workflow,
so you have to handle exceptional cases yourself.

### Stopping & resuming

`stop` halts processing entirely: the loop stops and `ping` is ignored, so no
new work is picked up. `start` resumes it (reusing the last `ping`ed
query/mutation). Call them on the component:

```ts
await ctx.runMutation(components.batchWorker.lib.stop, { name: "events" });
// ...later, when you want it processing again:
await ctx.runMutation(components.batchWorker.lib.start, { name: "events" });
```

`status` reports the run state, including whether the worker is `stopped`.

### `ping` vs `start`

- **`ping`** creates the worker on first call and resumes it when it's idle. It
  also wakes a loop that's sleeping on an idle `timeoutMs`. A ping is a no-op
  when it's already running, the next run is imminent (within ~1s), during a
  `debounceMs` window (the work gets picked up when the debounce elapses), or
  when the worker is stopped.
- **`start`** resumes a `stopped` worker. Ping will not resume when `stopped`.

### Testing with `convex-test`

Register the component in your test setup with the helper exported from
`@convex-dev/batch-worker/test`:

```ts
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import schema from "./schema";
import batchWorker from "@convex-dev/batch-worker/test";

const modules = import.meta.glob("./**/*.*s");

export function initConvexTest() {
  const t = convexTest(schema, modules);
  batchWorker.register(t); // pass a name if you mounted it under one
  return t;
}
```

`ping` itself returns immediately — the loop runs via scheduled functions — so
nothing processes until you drive the scheduler. Run the loop (and everything it
schedules) to completion with fake timers:

```ts
vi.useFakeTimers();
await t.mutation(api.example.addEvent, { value: 5 });
await t.finishAllScheduledFunctions(vi.runAllTimers);
```

See [example.test.ts](./example/convex/example.test.ts) and
[setup.test.ts](./example/convex/setup.test.ts).

Note: Use `convex-test` (≥ 0.0.55-alpha.0) for `v.commitTs()` support.

See the full working examples in the example app:
[example.ts](./example/convex/example.ts) (basic queue),
[aggregates.ts](./example/convex/aggregates.ts) (denormalized aggregates), and
[rateLimited.ts](./example/convex/rateLimited.ts) (async LLM batches).

## Debugging

- You can change the log level via an environment variable parameter to the
  component. It defaults to "REPORT".

```ts
app.use(batchWorker, { env: { LOG_LEVEL: "REPORT" } });
```

<!-- END: Include on https://convex.dev/components -->

## Development

Run the example app with a file watcher that rebuilds the component:

```sh
npm i
npm run dev
```

Run `npm run dev:frontend` (in a second terminal) to interact with it through
the Vite demo UI in [`example/src`](./example/src). It exercises all three
workers — the basic queue, the live scoreboard, and the async LLM batches.

The demo is hosted on Convex itself via
[`@convex-dev/static-hosting`](https://github.com/get-convex/static-hosting),
published to `https://<deployment>.convex.site`. See
[example/README.md](./example/README.md#deploy) for the deploy commands.

For a real-deployment comparison of returning values and patching directly
versus returning IDs and re-fetching before patching, see
[the benchmark results](./BENCHMARK.md) and
[how to run the benchmark](./example/README.md#benchmark-point-reads-before-patching).

### How it works

| Table         | Written by                          | Read by                 |
| ------------- | ----------------------------------- | ----------------------- |
| `workers`     | `ping`/`start`/`loop` (transitions) | `ping`/`start`, monitor |
| `workerState` | `loop` (every iteration)            | `loop`, monitor         |

The high-churn loop state lives in `workerState` (generation, heartbeat, the
scheduled runner, the monitor, and the cursor, which rides along on a patch the
loop already does every iteration), separate from the rarely-written `workers`
doc (which holds the handles, config, and run-status: `idle` / `running` /
`stopped`, plus a pointer to its `workerState`). That lets `ping`/`start` —
which you call on every insert — read `workers` and return without conflicting
(OCC) with the fast-looping loop. A monotonic `generation` (in `workerState`)
guarantees only one loop chain runs at a time: a superseded loop sees a
mismatched generation and exits. The liveness monitor is scheduled
~`monitorLagMs` _after_ the loop's next run and pushed back as the loop keeps
running, so it only fires (and restarts the loop) if the loop actually died.
