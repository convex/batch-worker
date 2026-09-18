# Re-fetching before patching

This benchmark compares two ways of processing a batch when no rows change
between selection and processing:

- **Direct patch:** a snapshot query returns `{ id, value }`; the mutation
  trusts that value and uses `Promise.all` to patch all rows with
  `{ processed: true, result: value + 1 }`.
- **Re-fetch:** a snapshot query returns IDs; the mutation fetches the rows with
  `Promise.all(ids.map(id => ctx.db.get(...)))`, then checks eligibility and
  applies the same patches with another `Promise.all` using current values.

Both variants scan the same index, use `ctx.runQuery` with
`useStaleSnapshot: true`, and invoke the worker through `ctx.runMutation` in the
same outer mutation, matching the component's query/mutation calling pattern.
Both variants issue patches concurrently. The re-fetch variant awaits all gets
before validating rows and issuing its patches. This gives the direct-patch
baseline the opportunity to fetch its target rows concurrently too, removing the
sequential-write bottleneck in the previous comparison. Queries pass only fields
needed for processing, so artificial document padding is not passed in mutation
arguments.

## Results: parallel patches in both variants

Measured on 2026-09-18 on dev `enchanted-cardinal-63`. Both variants were
measured afresh with `Promise.all` for writes. The re-fetch variant first awaits
`Promise.all` gets, checks eligibility, then awaits `Promise.all` patches. All
600 measured executions produced the expected results, with no reported OCC
retries or execution errors. The benchmark table was confirmed empty after
cleanup. Times are milliseconds per complete query-plus-mutation transaction.

| Rows per batch | Padding per row | Parallel patches mean | Parallel gets + patches mean | Mean difference | Paired 95% interval |
| -------------: | --------------: | --------------------: | ---------------------------: | --------------: | ------------------: |
|              1 |             0 B |                 15.96 |                        15.31 |           -0.65 |      -3.77 to +2.46 |
|             25 |             0 B |                 69.34 |                        25.10 |          -44.24 |    -47.61 to -40.86 |
|            100 |             0 B |                261.00 |                        65.25 |         -195.75 |  -248.52 to -142.99 |
|              1 |          4096 B |                 13.07 |                        13.53 |           +0.46 |      -0.38 to +1.30 |
|             25 |          4096 B |                 73.03 |                        29.56 |          -43.47 |    -48.50 to -38.44 |
|            100 |          4096 B |                256.23 |                        78.16 |         -178.08 |  -187.88 to -168.27 |

Explicit parallel gets reduced mean server time by **60–64% for 25 rows** and
**69–75% for 100 rows** compared with issuing direct patches in parallel. All
four paired intervals exclude zero. Single-row cases showed no clear difference.
Medians also favor re-fetching: for 100 rows they were 225.44 ms versus 62.69 ms
without padding, and 249.20 ms versus 77.82 ms with 4096 bytes of padding.

Both implementations issue all patch calls together. This result measures the
effect of explicit pre-fetching with that API call pattern; it does not
establish how the backend schedules the patches internally or isolate the
remaining latency difference to a particular cache or database operation.
Database usage is unchanged from the previous runs, as shown below.

Run ID: `79cc3d5a-a89f-43ef-95e1-9b774fc46beb`. Raw evidence is in
`.context/benchmark-parallel-patches-results/results.json`, `cases.json`, and
`logs.jsonl`.

## Earlier results: parallel gets, sequential patches

This run used sequential patches in both variants, as implemented in commit
`97ab116`. Its speedup does not establish the overhead of re-fetching compared
with direct patches that also run in parallel.

Measured on 2026-09-18 UTC (2026-09-17 PDT) on dev `enchanted-cardinal-63`. Both
variants were measured afresh in this run. All 600 measured executions produced
the expected results, with no reported OCC retries or execution errors. The
benchmark table was confirmed empty after cleanup. Times are milliseconds per
complete query-plus-mutation transaction.

| Rows per batch | Padding per row | Direct patch mean | Parallel-get mean | Mean difference | Paired 95% interval |
| -------------: | --------------: | ----------------: | ----------------: | --------------: | ------------------: |
|              1 |             0 B |             16.13 |             15.72 |           -0.42 |      -2.08 to +1.25 |
|             25 |             0 B |             98.30 |             48.71 |          -49.59 |    -70.46 to -28.72 |
|            100 |             0 B |            337.08 |             94.90 |         -242.18 |  -351.62 to -132.74 |
|              1 |          4096 B |             14.21 |             14.67 |           +0.46 |      -0.80 to +1.72 |
|             25 |          4096 B |             79.72 |             31.44 |          -48.29 |    -53.01 to -43.56 |
|            100 |          4096 B |            292.50 |             87.74 |         -204.77 |  -226.71 to -182.82 |

With patches still sequential in both variants, parallel gets reduced mean
server time by **50–61% for 25 rows** and **70–72% for 100 rows** in this run.
All four of those paired intervals exclude zero. Single-row cases showed no
clear difference. The medians also favor parallel gets: at 100 rows they were
280.26 ms versus 79.95 ms without padding, and 285.47 ms versus 82.35 ms with
4096 bytes of padding. The benchmark measures the complete transaction; it does
not isolate the database-internal reason for the improvement.

Run ID: `5b565bfd-2962-44b6-a408-856f1ef7b942`. Raw evidence is in
`.context/benchmark-parallel-results/results.json`, `cases.json`, and
`logs.jsonl`.

## Earlier results: sequential gets

The results below used the original implementation on dev `first-lobster-65`,
which awaited one get and one patch at a time. They do not measure `Promise.all`
gets. That implementation is available in commit `066836b`. Since the parallel
run uses a different deployment, compare each re-fetch variant with its own
direct-patch baseline; these runs do not isolate the speedup from changing
sequential gets to parallel gets.

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

Run ID: `478bc6c6-a4f9-40f6-bd71-1f6c15fead8e`. Raw evidence is in
`.context/benchmark-results/results.json`, `cases.json`, and `logs.jsonl`.

## Database usage

The read-document, read-byte, and write-byte measurements were identical in all
three runs, and deterministic across trials:

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

## Method

All runs use Convex JS 1.43.0. For each combination of batch size (1, 25, 100)
and document padding (0, 4096 bytes), discard five warmup pairs, then measure 50
paired trials with alternating variant order. This gives 600 measured executions
plus 60 warmup executions. Each pair uses the same rows, reset before each
variant, with no concurrent writers to those rows. All results are verified
after every execution. Fixtures are scoped to each case and removed in a
`finally` block.

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
`.context/benchmark-parallel-patches-results/`. Earlier runs are retained in
`.context/benchmark-parallel-results/` (parallel gets, sequential patches) and
`.context/benchmark-results/` (sequential gets and patches).

Each run is a warm, uncontended workload on one deployment. It does not
benchmark cold database reads, scheduler throughput, simultaneous writers, or
deliberately different snapshots. Re-fetching is needed for correctness when
eligibility or values can change, regardless of its measured overhead here. The
direct-patch variant is an intentional benchmark baseline, not general
application guidance.
