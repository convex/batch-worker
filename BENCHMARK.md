# Re-fetching before patching

This benchmark compares two ways of processing a batch when no rows change
between selection and processing:

- **Direct patch:** a snapshot query returns `{ id, value }`; the mutation
  trusts that value and patches `{ processed: true, result: value + 1 }`.
- **Re-fetch:** a snapshot query returns IDs; the mutation calls `db.get` for
  each ID, checks that the row exists and is unprocessed, then applies the same
  patch using the current value.

Both variants scan the same index, use `ctx.runQuery` with
`useStaleSnapshot: true`, and invoke the worker through `ctx.runMutation` in the
same outer mutation, matching the component's query/mutation calling pattern.
Both use sequential patches; the re-fetch variant adds a sequential point read
and eligibility check before each patch. Queries pass only fields needed for
processing, so artificial document padding is not passed in mutation arguments.

## Results

Measured on 2026-09-18 UTC (2026-09-17 PDT). All 600 measured executions
produced the expected results, with no reported OCC retries or execution errors.
Times below are milliseconds per complete query-plus-mutation transaction.

| Rows per batch | Padding per row | Direct patch mean | Re-fetch mean | Mean difference | Paired 95% interval |
| -------------: | --------------: | ----------------: | ------------: | --------------: | ------------------: |
|              1 |             0 B |             14.62 |         14.63 |           +0.01 |      -0.70 to +0.72 |
|             25 |             0 B |             87.46 |         86.80 |           -0.66 |      -4.65 to +3.33 |
|            100 |             0 B |            335.50 |        408.84 |          +73.34 |   -12.87 to +159.54 |
|              1 |          4096 B |             15.84 |         15.16 |           -0.68 |      -2.01 to +0.65 |
|             25 |          4096 B |             92.08 |         91.65 |           -0.43 |      -5.42 to +4.57 |
|            100 |          4096 B |            298.61 |        322.84 |          +24.23 |     +4.14 to +44.33 |

The 1- and 25-row cases did not show a clear latency difference. At 100 rows
with 4096 bytes of padding, re-fetching increased the mean by 8.1% in this run.
The 100-row case without padding had large latency outliers and an inconclusive
mean difference: medians were 312.94 ms versus 318.41 ms, while p95 values were
530.29 ms versus 994.53 ms. Its 21.9% mean increase should not be treated as a
stable overhead estimate.

Database usage was deterministic across trials:

| Rows per batch | Padding per row | Direct patch read docs | Re-fetch read docs | Direct patch read bytes | Re-fetch read bytes | Write bytes, either variant |
| -------------: | --------------: | ---------------------: | -----------------: | ----------------------: | ------------------: | --------------------------: |
|              1 |             0 B |                      2 |                  3 |                     380 |                 527 |                         282 |
|             25 |             0 B |                     50 |                 75 |                   9,575 |              13,275 |                       7,100 |
|            100 |             0 B |                    200 |                300 |                  38,600 |              53,500 |                      28,600 |
|              1 |          4096 B |                      2 |                  3 |                   8,581 |              12,827 |                       4,384 |
|             25 |          4096 B |                     50 |                 75 |                 214,600 |             320,775 |                     109,650 |
|            100 |          4096 B |                    200 |                300 |                 858,700 |           1,283,500 |                     438,800 |

Re-fetching added one reported document read per row: **50% more read documents
for the full query-plus-mutation transaction**, with identical writes. This is a
resource-usage measurement, not a claim of a 50% increase in total cost or
latency. Byte counts include stored row fields and metadata, not just padding.

Run ID: `478bc6c6-a4f9-40f6-bd71-1f6c15fead8e`. Raw evidence is in
`.context/benchmark-results/results.json`, `cases.json`, and `logs.jsonl`.

## Method

Run on the cloud dev deployment `first-lobster-65` with Convex JS 1.43.0. For
each combination of batch size (1, 25, 100) and document padding (0, 4096
bytes), discard five warmup pairs, then measure 50 paired trials with
alternating variant order. This gives 600 measured executions plus 60 warmup
executions. Each pair uses the same rows, reset before each variant, with no
concurrent writers to those rows. All results are verified after every
execution. Fixtures are scoped to each case and removed in a `finally` block.

Server time and database usage come from the outer mutation's Convex completion
log. Time includes the snapshot query and nested mutation, but excludes fixture
setup, resets, verification, cleanup, action orchestration, scheduler overhead,
and network latency to the CLI. The harness separately records the action's
`runMutation` round-trip time. No timers run inside mutations, where
`Date.now()` is fixed.

Paired differences are re-fetch minus direct patch. The reported 95% intervals
use a normal approximation from the standard error of the paired differences;
they describe variation within this run, not variation across deployments.

## Reproduce

```sh
npm ci
npx convex dev --once
node benchmark.mjs
```

The harness requires a dev deployment in `.env.local`. Configuration options are
documented in
[example/README.md](./example/README.md#benchmark-point-reads-before-patching).
Machine-readable results, action timings, and raw server logs are written to
`.context/benchmark-results/`.

This is a warm, uncontended workload on one deployment. It does not benchmark
cold database reads, scheduler throughput, simultaneous writers, or deliberately
different snapshots. Re-fetching is needed for correctness when eligibility or
values can change, regardless of its measured overhead here. The direct-patch
variant is an intentional benchmark baseline, not general application guidance.
