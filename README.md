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
app.use(batchWorker, { env: { LOG_LEVEL: "REPORT" } });

export default app;
```

The `env` option is optional, defaults shown above. The default mount name is
`batchWorker` (i.e. `components.batchWorker`). This works inside another
component too: call `component.use(batchWorker)` in your component's
`convex.config.ts`.

## Usage

Insert work into your own table, then call `ping`. Provide a query that returns
the next batch or `idle`, and a mutation that processes it. To ensure that the
batch shape always matches between the query and the mutation, use
`defineBatchWorkerValidators` to obtain all four argument and return validators.
(`kind: "work"` is optional — returning `{ batch }` alone also works.)

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

const vEventIds = v.array(v.id("events"));

// One declaration gives the query's args (`{ name, cursor? }`) and returns,
// plus the mutation's args. `cursor` defaults to a commit timestamp.
const { vQueryArgs, vQueryReturns, vMutationArgs } =
  defineBatchWorkerValidators({ batch: { ids: vEventIds } });

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

// Process one batch. The worker owns cleanup — delete what you process!
export const processBatch = internalMutation({
  args: vMutationArgs,
  handler: async (ctx, { ids }) => {
    for (const id of ids) {
      // The query may have read an older snapshot. Check the current row.
      const event = await ctx.db.get("events", id);
      if (!event) continue; // already processed or deleted
      // ... do the work using event.value (sum, schedule downstream jobs, etc.) ...

      // Clean up the work you processed.
      await ctx.db.delete("events", id);
    }
    // Returning nothing re-runs immediately to drain the rest.
  },
});
```

The component **does not clean up your work for you** — your worker mutation is
responsible for deleting (or marking complete / advancing past) the rows it
processed, otherwise the next query will return them again.

### Find work in the query, validate it in the mutation

Treat the work query and the worker mutation as **two separate transactions**.
The query may read an older database snapshot than the mutation. There is **no
guarantee that the rows or values returned by the query are still current** when
the mutation runs: rows may have changed, been deleted, or already been
processed.

- The **work query** runs as a snapshot read that takes **no read
  dependencies**. It can scan the queue (`.take(BATCH_SIZE)` over an index)
  alongside concurrent inserts.
- The **worker mutation** is a normal transaction: every range it reads becomes
  a read dependency. If it re-queries the range of work in the queue, concurrent
  inserts would conflict. Keep queue scans in the query and use point reads by
  `_id` to validate selected rows in the mutation.

The default pattern is to **return IDs from the query, then re-fetch those rows
in the mutation**. Check that each row still exists and is eligible for work
(for example, `state === "pending"`), and compute updates from its current
values. Skip rows that have already been processed. These point reads
participate in the mutation's conflict detection without adding a dependency on
the whole queue.

You can pass values through `batch` when your application can safely process
older values, such as immutable, append-only events tracked with an exclusive
cursor. Document that assumption. Patching a row by `_id` takes a dependency in
the mutation's snapshot; it **does not validate values from the query's older
snapshot** or establish that the row is still eligible for processing.

```ts
// Query: find candidate rows without adding queue-wide read dependencies.
return {
  kind: "work" as const,
  batch: { ids: rows.map((row) => row._id) },
};
```

```ts
// Mutation: validate each candidate in the snapshot used for the writes.
for (const id of ids) {
  const row = await ctx.db.get("tasks", id);
  if (!row || row.state !== "pending") continue;
  await ctx.db.patch("tasks", id, { state: "started" });
  // Schedule work using the current row's values.
}
```

### Steering the loop dynamically

Your worker mutation may return `{ debounceMs }` to throttle the loop, and a
`cursor` to override the query's (see [The cursor](#the-cursor)):

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
cursor stays where it was and the query retries from that position. The retry
may return a different batch as the query's snapshot changes.

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

Do **not** use `_creationTime`. It's assigned when a mutation _starts_, so a row
inserted by a slow mutation can land _behind_ rows the worker has already
queried past.

**Scan with `gte`.** Everything a single mutation inserts shares one commit
timestamp, so a batch can end in the middle of such a tie and the next scan has
to start at the tie to pick up the rest. Re-reading from the tie costs at most
one mutation's worth of already-processed rows.

To end each batch on a tie boundary instead, read the remaining documents at
that commit timestamp into the batch and scan with `gt`. That also processes
work added "at once" together, as long as it fits in one transaction. See
[the aggregate example](./example/convex/aggregates.ts).

#### Other cursor types

The cursor can be any Convex value, for instance a `paginator` cursor from
`convex-helpers`, which captures the index range
`[commitTs, _creationTime, _id]` so you know exactly where you left off. Pass
`cursor` to `defineBatchWorkerValidators` and all four validators pick it up:

```ts
const { vQueryArgs, vQueryReturns, vMutationArgs, vMutationReturns } =
  defineBatchWorkerValidators({
    batch: { ids: v.array(v.id("myWork")) },
    cursor: v.string(),
  });
```

`ping` takes the cursor's type from the work query's `cursor` arg and checks
both return types against it, so a mismatch points at one place.

#### Adjusting the cursor from the worker mutation

The worker mutation can return a `cursor` that overrides the query's. Use it
when the batch made partial progress and you can work out how far it got, e.g.
from a per-item timestamp carried in the batch:

```ts
return { cursor: lastProcessed.updatedAt };
```

If it is not returned, it will defer to the cursor returned by the work query,
if one was returned, or keep the old value. Note: if the cursor does not advance
and you did not update anything the query read, you may end up in an infinite
loop.

#### Reading and resetting the cursor

The work query receives the cursor in its args. To read it elsewhere, say from a
query counting pending work, call the component like `status`:

```ts
const from = ((await ctx.runQuery(components.batchWorker.lib.getCursor, {
  name: "events",
})) ?? 0n) as bigint;
```

`lib.setCursor` overwrites it, and clears it when `cursor` is omitted, so the
next scan starts from the front. Use it for migrations and recovery: the loop
writes that document every iteration, so a call made while the worker is busy is
liable to conflict. It throws if the worker doesn't exist yet (`ping` creates
it).

#### Why is a cursor necessary?

The reason is due to a technical nuance of how Convex tracks document changes.
Internally, Convex stores previous versions of documents in indexes for some
time (~minutes). Old values will not be returned in results to JS, but it can
slow down queries if they have to scan and discard thousands of these entries.

In the simple example above, a `.take(BATCH_SIZE)` from the front of a table
followed by deleting all of those documents results in the beinning of the
table's index to be full of deleted documents, which the next query then scans
before reaching the next batch of work.

The solution is to keep a cursor to track your progress, and make your next
query starting at the cursor, allowing it to skip over the region of the index
full of previous versions or previously-handled work.

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
batch work that requires `fetch`— calling an LLM, hitting a third-party API —
have the worker mutation _claim_ a batch: re-fetch the candidate IDs, check that
each row is still pending, and mark those rows started. Then schedule the
action, or enqueue it in a Workpool, using only the rows actually claimed. A
stale query can return previously claimed rows, so the mutation must skip them.
The action does the work and calls a mutation to commit the results back.

Full working code is in [rateLimited.ts](./example/convex/rateLimited.ts). It
also rate-limits the batches, covered next.

Tip: if you use a Workpool, you can configure retries on the action, and commit
the results or handle any error in the `onComplete` handler, which has the nice
property of being called exactly once. You can pass through information about
the batch in the `context` for the `onComplete` handler so you can update them
even in the case of failure. It will also help you manage parallelism of async
work, so live-site requests aren't impacted by spikey workloads.

If you don't use a Workpool, you can detect failure of the scheduled job and
manage retries yourself.

### Rate limiting strategy

You can use Batch Worker with the
[Rate Limiter component](https://www.convex.dev/components/rate-limiter) to
bound how fast the loop does work, for example to respect an external API limit.

Full working code is in [rateLimited.ts](./example/convex/rateLimited.ts).

Tips for rate-limiting LLM calls:

- You can use the tokens returned from the previous LLM request to get accurate
  token counts of the previous messages.
- Consuming a rate limit after the request is a good trade-off for APIs that
  have some grace around bursts of requests, and where you don't know the full
  usage up-front. The post-request adjustment serves to delay future requests so
  that your overall usage matches the rate limit, even if you temporarily go
  above it.
- By using the rate limiter's **reserve** functionality, it can avoid trial and
  error: a reservation never rejects, but rather reserves future capacity if
  necessary. It returns a `retryAfter` value instructing you how long to wait
  before executing your request.
- Use `retryAfter` two ways — to schedule the call for when you're actually
  allowed to make it, and as `debounceMs` to delay assembling the next batch.
- The simplest version of this is to use `rateLimiter.check(ctx, name)` to
  determine any necessary delay to account for previous requests, then consume
  the limit based on the full usage using
  `rateLimiter.limit(ctx, name, { count: totalTokens, reserve: true })` after
  the request completes.
- For more accurate tracking, you can reserve capacity before the request based
  on **input** token estimations, then account for the **output** tokens
  afterwards, making a call with `reserve: true` from both places.
- If you'd rather delay the worker mutation until there's enough capacity, the
  work query can call `rateLimiter.check(...)` (read-only) and return
  `{ kind: "idle", timeoutMs: retryAfter }` instead.

### Failure handling

If your work query or worker mutation throws, the loop dies and the liveness
monitor restarts it after ~`monitorLagMs`. The failed mutation's writes and
cursor advance roll back, so the query retries from the previous cursor. Its
next batch may differ because it can read a different snapshot. Design for
repeated delivery and re-check rows in the mutation before applying effects. One
poison item that always throws can wedge the queue. For work that can fail per
item, catch errors inside the worker mutation, and isolate bad docs in a table
for async debugging.

This is a low-level primitive, relative to components like Workpool or Workflow,
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
