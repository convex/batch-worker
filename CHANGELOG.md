# Changelog

## 0.3.7

### Patch Changes

- 4292317: Return the registered component API from the test helper and clarify
  how work-query snapshots relate to worker mutations.

## 0.3.6

- Updates the /test entrypoint for compatibility with convex-test's new
  `defineTestApp` capability.

## 0.3.5

- Improve the test entrypoint generics

## 0.3.4

- Remove the unnecessary react peer dependency and entrypoint

## 0.3.3

- Enforce a cooldown period whenever the worker starts running, even if the
  query hasn't returned work for a while. Results in more idle loop iterations.
- Transitions to "running" on ping even when already scheduled due to timeout.

## 0.3.2

- Fix: Prefer a sooner timeoutMs over a ping's debounceMs when idle.
- Adds a lib:kick function to run if you ever get into a degenerate situation
  where the worker and monitor are both dead (e.g. you cancel all scheduled
  functions from the dashboard for this component)

## 0.3.1

- More graceful handling of monitor execution and backoff for wedged workers.
- Cancels and re-schedules a worker if it's "pending" for over a minute.

## 0.3.0

- Provide a worker-persisted cursor to make it easier to implement iterating
  through work using commitTs, which optimizes your queries to skip slow regions
  of the database full of deleted items.
- Introduces `defineBatchWorkerValidators`, deprecates vBatchQueryArgs,
  vBatchResult, etc.
- Requires Convex 1.43+ for v.commitTs() and the new `ctx.runQuery` options.

## 0.2.2 (patch on 0.2.1, not included in 0.3.0)

- Enfoce a cooldown period whenever the worker starts running, even if the query
  hasn't returned work for a while. Results in more idle loop iterations.

## 0.2.1 (patch on 0.2.0, not included in 0.3.0)

- More graceful handling of monitor execution and backoff for wedged workers.
- Cancels and re-schedules a worker if it's "pending" for over a minute.

## 0.2.0

- Removes the heartbeat field (breaking)
- Removes the thick client in favor of a standalone `ping` function

## 0.1.0

- Initial release.
