# Example app

A live demo of `@convex-dev/batch-worker`. The backend ([`convex/`](./convex))
defines three named workers and the Vite UI ([`src/`](./src)) drives each one:

- **Work queue** ([example.ts](./convex/example.ts)) — batch and sum events.
- **Live scoreboard** ([aggregates.ts](./convex/aggregates.ts)) — a single
  writer folds scores into per-team totals with no write contention.
- **Rate-limited LLM batches** ([rateLimited.ts](./convex/rateLimited.ts)) —
  collect requests and spend a token budget on async calls.

All three drain their queue by returning a `v.commitTs()` cursor from the work
query. The component commits it with the batch and hands it back on the next
call, so each scan resumes where the last one stopped.

The work query may read an older snapshot than the worker mutation, but each
round sees this worker's committed writes from previous rounds, including
deletes and claims. The queue and LLM examples return IDs and re-fetch current
rows to handle edits, deletes, or claims by other mutations between snapshots.
If only this worker can change or remove queued work, values can be passed
directly through the batch. The scoreboard does this because its score events
are immutable and its exclusive cursor tracks processed events.

Run all commands from the **root of the repo**.

## Develop

```sh
npm run dev          # backend + component watcher
npm run dev:frontend # Vite dev server (second terminal)
```

## Benchmark point reads before patching

After pushing the backend to your dev deployment, run from the repo root:

```sh
npx convex dev --once
node benchmark.mjs
```

This compares a snapshot query returning `{ id, value }` followed by direct
patches against a snapshot query returning IDs followed by `db.get`, an
eligibility check, and the same patches. Both paths use sequential patches. Only
the fields needed for processing are passed through the batch; optional document
padding measures the effect of larger stored rows.

The default run measures 50 paired trials after five warmup pairs for batches of
1, 25, and 100 rows, with 0 or 4096 padding bytes per row. Trial order
alternates. There are no concurrent writers, and every trial verifies that all
rows received identical results. Setup, reset, verification, and cleanup are
outside the measured transaction. Fixtures live in a separate table and are
deleted after each case. All benchmark functions are internal.

Results and raw server completion logs are saved to
`.context/benchmark-results/`. Server execution time includes the snapshot query
and nested worker mutation, but excludes scheduling and network latency to the
CLI. The action's `runMutation` round-trip timing is also recorded. This
measures the overhead of re-fetching when rows have not changed; it does not
simulate stale snapshots or measure conflict retries under load.

For a shorter run or different batch sizes:

```sh
node benchmark.mjs --trials 10 --warmups 2 --batch-sizes 25,100 --padding-bytes 0
```

The harness requires a `dev:` deployment in `.env.local` and refuses a
deploy-key override. See [BENCHMARK.md](../BENCHMARK.md) for recorded results
and limitations.

## Deploy

The demo is hosted on Convex with
[`@convex-dev/static-hosting`](https://github.com/get-convex/static-hosting):
the component owns `/` and serves the built assets alongside the backend. These
are one-off commands, so they aren't wired into `package.json`.

Smoke-test against the **dev** deployment your local `npm run dev` already
pushes to — build with the repo's Node, then upload the prebuilt `dist/`:

```sh
(cd example && vite build)
npx static-hosting upload --dist example/dist
```

Ship to **production** — this builds with the prod `VITE_CONVEX_URL`, deploys
the backend, and publishes to `https://<deployment>.convex.site`:

```sh
npx static-hosting deploy --dist example/dist --build-command '(cd example && vite build)'
```
