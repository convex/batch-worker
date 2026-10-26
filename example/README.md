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
