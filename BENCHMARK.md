# Re-fetching before patching

This benchmark compares three ways of processing a batch when no rows change
between selection and processing:

- **Direct patch:** a snapshot query returns `{ id, value }`; the mutation
  trusts that value and uses `Promise.all` to patch all rows with
  `{ processed: true, result: value + 1 }`.
- **Re-fetch:** a snapshot query returns IDs; one `Promise.all` wraps async
  tasks that each get a row, check eligibility, and apply the same patch using
  its current value.
- **Re-fetch with values:** the same query and `{ items: [{ id, value }] }`
  mutation arguments as direct patch, but supplied values are ignored. It uses
  the same re-fetch helper as the IDs-only variant. This control keeps the query
  return values and mutation arguments identical to direct patch.

None of these variants passes full documents. Even the original direct-patch
baseline passed only `{ id, value }`; document padding stays in the database.

The re-fetch mutation processes each ID like this:

```ts
const processed = await Promise.all(
  ids.map(async (id) => {
    const row = await ctx.db.get("benchmarkItems", id);
    if (!row || row.processed) return 0;
    await ctx.db.patch("benchmarkItems", id, {
      processed: true,
      result: row.value + 1,
    });
    return 1;
  }),
);
return processed.reduce<number>((sum, count) => sum + count, 0);
```

All variants scan the same index, use `ctx.runQuery` with
`useStaleSnapshot: true`, and invoke the worker through `ctx.runMutation` in the
same outer mutation, matching the component's query/mutation calling pattern.
All variants issue work concurrently. Each re-fetch task can patch as soon as
its own get and check finish; there is no barrier waiting for all gets to
complete. Queries pass only fields needed for processing, so artificial document
padding is not passed in mutation arguments.

## Results: control for the query and mutation payload

Measured on 2026-09-19 UTC (2026-09-18 PDT) on dev `enchanted-cardinal-63`. All
three variants were measured together in 50 matched trials per case, with all
six execution orders cycled. All 900 measured executions produced the expected
results, with no reported OCC retries or execution errors. The benchmark table
was confirmed empty after cleanup. Means below are milliseconds per complete
query-plus-mutation transaction.

| Rows per batch | Padding per row | Values → patch | IDs → re-fetch/patch | Values → re-fetch/patch |
| -------------: | --------------: | -------------: | -------------------: | ----------------------: |
|              1 |             0 B |          18.83 |                16.63 |                   26.91 |
|             25 |             0 B |         107.17 |                40.31 |                   41.98 |
|            100 |             0 B |         342.30 |                98.92 |                  123.54 |
|              1 |          4096 B |          16.89 |                16.46 |                   16.72 |
|             25 |          4096 B |         103.29 |                39.61 |                   40.67 |
|            100 |          4096 B |         388.43 |               106.36 |                  114.60 |

Two paired comparisons test the payload hypothesis. The first holds the payload
constant and adds re-fetching. The second holds re-fetching constant and changes
the payload from IDs to `{ id, value }`. That comparison includes constructing
and validating the payload and extracting IDs in the control mutation; it is not
an isolated serialization measurement:

| Rows | Padding | Re-fetch minus patch, identical payload (mean) | Paired 95% interval | Values minus IDs, both re-fetch (mean) | Paired 95% interval |
| ---: | ------: | ---------------------------------------------: | ------------------: | -------------------------------------: | ------------------: |
|    1 |     0 B |                                          +8.08 |     -3.38 to +19.54 |                                 +10.28 |     -1.82 to +22.38 |
|   25 |     0 B |                                         -65.19 |    -77.92 to -52.47 |                                  +1.67 |      -4.80 to +8.15 |
|  100 |     0 B |                                        -218.76 |  -275.85 to -161.67 |                                 +24.61 |    -18.80 to +68.03 |
|    1 |  4096 B |                                          -0.17 |      -2.70 to +2.36 |                                  +0.26 |      -2.20 to +2.73 |
|   25 |  4096 B |                                         -62.62 |    -77.95 to -47.29 |                                  +1.07 |      -5.94 to +8.07 |
|  100 |  4096 B |                                        -273.83 |  -311.09 to -236.57 |                                  +8.24 |     -7.17 to +23.65 |

With identical query results and mutation arguments, re-fetching still reduced
mean server time by **about 61% for 25 rows** and **64–71% for 100 rows**. All
four paired intervals exclude zero. The payload difference therefore does not
explain the large speedup in this workload.

Every interval for the payload-only comparison includes zero; this run does not
establish a consistent latency penalty for passing values. It does not prove
zero overhead either. Means are noisy: at 100 rows without padding, re-fetching
with values had a mean 24.61 ms above IDs-only, but their medians were 91.55 ms
and 89.02 ms respectively. The direct-patch median was 307.50 ms. The
measurements still do not identify the backend cache, I/O, or scheduling reason
for the remaining difference. Full-document payloads are not tested here.

Run ID: `b5b845ca-810a-422e-a541-f86d8b17ac03`. Raw evidence is in
`.context/benchmark-payload-control-results/results.json`, `cases.json`, and
`logs.jsonl`. The JSON includes all three paired comparisons and action timings.

## Earlier results: one Promise.all over get, check, and patch

This run compared only direct patch with IDs-only re-fetching, as implemented in
commit `5fdba09`.

Measured on 2026-09-19 UTC (2026-09-18 PDT) on dev `enchanted-cardinal-63`. Both
variants were measured afresh. All 600 measured executions produced the expected
results, with no reported OCC retries or execution errors. The benchmark table
was confirmed empty after cleanup. Times are milliseconds per complete
query-plus-mutation transaction.

| Rows per batch | Padding per row | Parallel patches mean | Per-row get/check/patch mean | Mean difference | Paired 95% interval |
| -------------: | --------------: | --------------------: | ---------------------------: | --------------: | ------------------: |
|              1 |             0 B |                 13.19 |                        13.22 |           +0.03 |      -0.95 to +1.01 |
|             25 |             0 B |                 67.52 |                        28.27 |          -39.26 |    -46.34 to -32.17 |
|            100 |             0 B |                263.39 |                        74.57 |         -188.82 |  -221.30 to -156.34 |
|              1 |          4096 B |                 15.06 |                        15.58 |           +0.52 |      -1.44 to +2.49 |
|             25 |          4096 B |                 84.73 |                        28.79 |          -55.94 |    -69.30 to -42.57 |
|            100 |          4096 B |                256.46 |                        83.98 |         -172.48 |  -187.61 to -157.35 |

Re-fetching reduced mean server time by **58–66% for 25 rows** and **67–72% for
100 rows** in this run. All four paired intervals exclude zero. Single-row cases
showed no clear difference. For 100 rows, medians were 241.65 ms versus 66.91 ms
without padding and 244.84 ms versus 80.35 ms with padding. The separately
recorded action round-trip timings also favor re-fetching for all multi-row
cases.

The lower latency persists when each row's get, check, and patch share a single
async callback. It therefore does not require an explicit barrier waiting for
every get before starting any patches. Re-fetching still adds an explicit get
and one reported document read per row, with identical writes. These
measurements do not explain why the additional work has lower latency: they do
not identify the backend's cache behavior, actual I/O, or internal scheduling.
The earlier two-phase version was measured in a separate run, so the difference
between its timings and these timings is not a paired comparison of the two
re-fetch arrangements.

Run ID: `9f50beef-4b63-4bea-8290-b0c6561a6a90`. Raw evidence is in
`.context/benchmark-interleaved-results/results.json`, `cases.json`, and
`logs.jsonl`.

## Earlier results: all parallel gets, then all parallel patches

This run used the two-phase implementation in commit `93b2ab5`.

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
`a3d37cc`. Its speedup does not establish the overhead of re-fetching compared
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
gets. That implementation is available in commit `c8a3d5c`. Since the parallel
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
five runs, and deterministic across trials. In the payload-control run, both
re-fetch variants have the same usage shown in the re-fetch columns:

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
and document padding (0, 4096 bytes), discard five warmup trials, then measure
50 matched trials. The current payload-control run executes all three variants
in each trial, cycling through all six orders to balance position and
preceding-variant effects. This gives 900 measured executions plus 90 warmup
executions. Earlier runs used two variants in alternating order, giving 600
measured executions plus 60 warmups. Each trial uses the same rows, reset before
each variant, with no concurrent writers to those rows. All results are verified
after every execution. Fixtures are scoped to each case and removed in a
`finally` block.

Server time and database usage come from the outer mutation's Convex completion
log. Time includes the snapshot query and nested mutation, but excludes fixture
setup, resets, verification, cleanup, action orchestration, scheduler overhead,
and network latency to the CLI. The harness separately records the action's
`runMutation` round-trip time. No timers run inside mutations, where
`Date.now()` is fixed.

Paired differences are computed within each trial. Comparisons are re-fetch
minus direct patch, re-fetch with values minus direct patch (identical
payloads), and re-fetch with values minus IDs-only re-fetch (identical worker
logic). The reported 95% intervals use a normal approximation from the standard
error of the paired differences; they describe variation within this run, not
variation across deployments.

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
`.context/benchmark-payload-control-results/`. Earlier runs are retained in
`.context/benchmark-interleaved-results/` (per-row get/check/patch with IDs),
`.context/benchmark-parallel-patches-results/` (all parallel gets, then all
parallel patches), `.context/benchmark-parallel-results/` (parallel gets,
sequential patches), and `.context/benchmark-results/` (sequential gets and
patches).

Each run is a warm, uncontended workload on one deployment. It does not
benchmark cold database reads, scheduler throughput, simultaneous writers, or
deliberately different snapshots. Re-fetching is needed for correctness when
eligibility or values can change, regardless of its measured overhead here. The
direct-patch variant is an intentional benchmark baseline, not general
application guidance.
