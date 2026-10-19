#!/usr/bin/env node
// Live scheduler/Workpool cadence comparison. Internal functions are invoked
// through the authenticated Convex CLI; no admin key is extracted or persisted.
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { createRequire } from "node:module";

const { values } = parseArgs({
  options: {
    "duration-ms": { type: "string", default: "10000" },
    trials: { type: "string", default: "3" },
    out: { type: "string", default: ".context/execution-benchmark" },
    pilot: { type: "boolean", default: false },
    summarize: { type: "boolean", default: false },
  },
});
if (values.summarize) {
  writeReport(
    JSON.parse(readFileSync(`${values.out}/results.json`, "utf8")),
    values.out,
  );
  process.exit(0);
}
const durationMs = Number(values["duration-ms"]);
const trials = Number(values.trials);
if (
  !Number.isInteger(durationMs) ||
  durationMs < 2000 ||
  durationMs > 60_000 ||
  !Number.isInteger(trials) ||
  trials < 1 ||
  trials > 10
) {
  throw new Error("Use duration-ms 2000–60000 and trials 1–10");
}
const envFile = readFileSync(".env.local", "utf8");
const deployment =
  process.env.CONVEX_DEPLOYMENT ??
  envFile.match(/^CONVEX_DEPLOYMENT=([^\s#]+)/m)?.[1];
if (!deployment?.startsWith("dev:"))
  throw new Error("This benchmark requires a configured dev deployment");
const deploymentName = deployment.slice(4);
const cli = "node_modules/convex/bin/main.js";
const exec = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const out = values.out;
mkdirSync(out, { recursive: true });
async function run(fn, args) {
  const { stdout } = await exec(
    process.execPath,
    [
      cli,
      "run",
      "--deployment",
      deploymentName,
      `executionBenchmark:${fn}`,
      JSON.stringify(args),
    ],
    { maxBuffer: 2_000_000 },
  );
  return stdout.trim() ? JSON.parse(stdout) : null;
}

const raw = [];
let buffer = "";
const logs = spawn(
  process.execPath,
  [
    cli,
    "logs",
    "--deployment",
    deploymentName,
    "--history",
    "1",
    "--success",
    "--jsonl",
  ],
  { stdio: ["ignore", "pipe", "pipe"] },
);
let ready;
const connected = new Promise((resolve) => {
  ready = resolve;
});
let logErrors = "";
logs.stderr.on("data", (chunk) => {
  logErrors += chunk;
});
logs.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  let newline;
  while ((newline = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    try {
      raw.push(JSON.parse(line));
      ready();
    } catch {
      /* CLI notices */
    }
  }
});

function completions() {
  const unique = new Map();
  for (const event of raw)
    if (event.kind === "Completion") unique.set(event.executionId, event);
  return [...unique.values()];
}
function markers(events, runId) {
  const points = [];
  for (const event of events) {
    if (event.error || event.willRetry || event.parentExecutionId) continue;
    for (const line of event.logLines ?? []) {
      const message = (line.messages ?? []).join(" ");
      if (!message.includes("BATCH_BENCH")) continue;
      const marker = JSON.parse(
        message.slice(message.indexOf("{"), message.lastIndexOf("}") + 1),
      );
      if (marker.runId !== runId) continue;
      points.push({
        ...marker,
        startMs: event.executionTimestamp * 1000,
        finishedMs: event.timestamp * 1000,
        executionMs: event.executionTime * 1000,
        executionId: event.executionId,
        requestId: event.requestId,
      });
    }
  }
  return points;
}
function stats(nums) {
  if (!nums.length) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const percentile = (p) =>
    sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
  return {
    n: nums.length,
    mean: nums.reduce((a, b) => a + b, 0) / nums.length,
    p50: percentile(0.5),
    p95: percentile(0.95),
    min: sorted[0],
    max: sorted.at(-1),
  };
}
function summarize(config, started, points, events) {
  const warmupMs = Math.min(1000, durationMs / 4);
  const phase = config.mode === "busy" ? "iteration" : "poll";
  const measured = points.filter(
    (p) =>
      p.phase === phase &&
      p.startMs >= started.startedAt + warmupMs &&
      p.startMs < started.deadline,
  );
  const gaps = [],
    queueGaps = [];
  const byWorker = started.names.map((name) => {
    const ordered = measured
      .filter((p) => p.name === name)
      .sort((a, b) => a.startMs - b.startMs);
    if (ordered.length < 3)
      throw new Error(
        `Too few successful samples for ${name}: ${ordered.length}`,
      );
    for (let i = 1; i < ordered.length; i++) {
      gaps.push(ordered[i].startMs - ordered[i - 1].startMs);
      queueGaps.push(ordered[i].startMs - ordered[i - 1].finishedMs);
    }
    if (phase === "iteration")
      for (let i = 1; i < ordered.length; i++) {
        if (ordered[i].iteration !== ordered[i - 1].iteration + 1)
          throw new Error("Missing/duplicate iteration logs");
      }
    return {
      name,
      samples: ordered.length,
      rate:
        ((ordered.length - 1) * 1000) /
        (ordered.at(-1).startMs - ordered[0].startMs),
    };
  });
  const functionCalls = {};
  for (const event of events) {
    const t = event.executionTimestamp * 1000;
    if (
      t < started.startedAt + warmupMs ||
      t >= started.deadline ||
      event.caller !== "Scheduler"
    )
      continue;
    if (
      !(
        event.componentPath === "batchWorker" ||
        event.componentPath?.startsWith("benchmarkPool")
      )
    )
      continue;
    const key = `${event.componentPath}/${event.identifier}`;
    functionCalls[key] = (functionCalls[key] ?? 0) + 1;
  }
  return {
    ...config,
    ...started,
    warmupMs,
    successfulSamples: measured.length,
    cadenceMs: stats(gaps),
    executionMs: stats(measured.map((p) => p.executionMs)),
    queueGapMs: stats(queueGaps),
    aggregateIterationsPerSec: byWorker.reduce((n, w) => n + w.rate, 0),
    byWorker,
    functionCalls,
    failedExecutions: events.filter(
      (e) =>
        e.error &&
        e.executionTimestamp * 1000 >= started.startedAt &&
        e.executionTimestamp * 1000 < started.deadline,
    ).length,
    points,
  };
}

const backends = [
  { backend: "scheduler", maxParallelism: 10 },
  { backend: "workpool", maxParallelism: 10 },
  { backend: "workpool", maxParallelism: 1 },
];
const workloads = [
  { mode: "busy", pollIntervalMs: 0, workers: 1 },
  { mode: "poll", pollIntervalMs: 0, workers: 1 },
  { mode: "poll", pollIntervalMs: 200, workers: 1 },
  { mode: "busy", pollIntervalMs: 0, workers: 10 },
];
const cases = workloads.flatMap((workload) =>
  backends
    .filter((b) => workload.workers === 1 || b.maxParallelism === 10)
    .map((backend) => ({ ...workload, ...backend })),
);
const selected = values.pilot
  ? cases.filter(
      (c) =>
        c.workers === 1 && c.maxParallelism === 10 && c.pollIntervalMs === 0,
    )
  : cases;
const results = {
  deployment: deploymentName,
  startedAt: new Date().toISOString(),
  durationMs,
  trials,
  packageVersions: {
    convex: JSON.parse(readFileSync("node_modules/convex/package.json", "utf8"))
      .version,
    workpool: JSON.parse(
      readFileSync("node_modules/@convex-dev/workpool/package.json", "utf8"),
    ).version,
    workpoolDriver: createRequire(
      createRequire(import.meta.url).resolve(
        "@convex-dev/workpool/package.json",
      ),
    )("@convex-dev/batch-worker/package.json").version,
  },
  runs: [],
};
let activeNames = [];
function save() {
  writeFileSync(`${out}/results.json`, JSON.stringify(results, null, 2));
  // Retain raw benchmark-related completion events for reproducibility.
  const relevant = completions().filter(
    (e) =>
      e.componentPath === "batchWorker" ||
      e.componentPath?.startsWith("benchmarkPool") ||
      e.identifier.startsWith("executionBenchmark:"),
  );
  writeFileSync(
    `${out}/executions.jsonl`,
    relevant.map((e) => JSON.stringify(e)).join("\n") + "\n",
  );
}
try {
  await Promise.race([
    connected,
    sleep(10_000).then(() => {
      throw new Error(`Log stream did not connect: ${logErrors}`);
    }),
  ]);
  for (let trial = 0; trial < trials; trial++) {
    // Alternate execution order to reduce time/order bias.
    const ordered = trial % 2 ? [...selected].reverse() : selected;
    for (const config of ordered) {
      const runId = `${Date.now()}-${trial}-${config.backend}-${config.mode}-${config.pollIntervalMs}-${config.workers}-${config.maxParallelism}`;
      console.log(
        `Starting trial ${trial + 1}: ${config.backend} slots=${config.maxParallelism}, ${config.mode}/${config.pollIntervalMs}ms, workers=${config.workers}`,
      );
      const started = await run("start", { ...config, durationMs, runId });
      activeNames = started.names;
      await sleep(durationMs + 300);
      const timeout = Date.now() + 15_000;
      while (!(await run("status", { names: activeNames }))) {
        if (Date.now() >= timeout)
          throw new Error("Benchmark did not become idle");
        await sleep(500);
      }
      activeNames = [];
      await sleep(2000); // finish pool completions and flush the log stream
      const events = completions();
      const result = summarize(
        { ...config, runId, trial: trial + 1 },
        started,
        markers(events, runId),
        events,
      );
      results.runs.push(result);
      save();
      console.log(
        `  ${result.successfulSamples} samples; interval p50=${result.cadenceMs.p50.toFixed(1)}ms p95=${result.cadenceMs.p95.toFixed(1)}ms; aggregate=${result.aggregateIterationsPerSec.toFixed(1)}/s`,
      );
    }
  }
} finally {
  try {
    if (activeNames.length) await run("stop", { names: activeNames });
  } finally {
    logs.kill("SIGTERM");
    save();
  }
}
writeReport(results, out);
console.log(`Results: ${out}/results.json`);

function writeReport(results, output) {
  const groups = new Map();
  for (const run of results.runs) {
    const key = [
      run.mode,
      run.pollIntervalMs,
      run.workers,
      run.backend,
      run.maxParallelism,
    ].join(":");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(run);
  }
  const rows = [...groups.values()].map((runs) => {
    const gaps = [],
      execution = [],
      queueGaps = [];
    for (const run of runs) {
      const phase = run.mode === "busy" ? "iteration" : "poll";
      for (const name of run.names) {
        const points = run.points
          .filter(
            (p) =>
              p.name === name &&
              p.phase === phase &&
              p.startMs >= run.startedAt + run.warmupMs &&
              p.startMs < run.deadline,
          )
          .sort((a, b) => a.startMs - b.startMs);
        execution.push(...points.map((p) => p.executionMs));
        for (let i = 1; i < points.length; i++) {
          gaps.push(points[i].startMs - points[i - 1].startMs);
          queueGaps.push(points[i].startMs - points[i - 1].finishedMs);
        }
      }
    }
    const { mode, pollIntervalMs, workers, backend, maxParallelism } = runs[0];
    const samples = runs.reduce((n, r) => n + r.successfulSamples, 0);
    return {
      mode,
      pollIntervalMs,
      workers,
      backend,
      maxParallelism,
      trials: runs.length,
      samples,
      cadenceMs: stats(gaps),
      executionMs: stats(execution),
      queueGapMs: stats(queueGaps),
      aggregateIterationsPerSec: stats(
        runs.map((r) => r.aggregateIterationsPerSec),
      ),
      scheduledExecutionsPerIteration:
        runs.reduce(
          (n, r) =>
            n + Object.values(r.functionCalls).reduce((a, b) => a + b, 0),
          0,
        ) / samples,
      failedExecutions: runs.reduce((n, r) => n + r.failedExecutions, 0),
    };
  });
  const summary = {
    ...results,
    rows,
    runs: results.runs.map((run) => {
      const summary = { ...run };
      delete summary.points;
      return summary;
    }),
  };
  writeFileSync(`${output}/summary.json`, JSON.stringify(summary, null, 2));
  const lines = [
    "# Scheduler vs Workpool execution cadence",
    "",
    `Deployment: ${results.deployment}. Started: ${results.startedAt}.`,
    "",
    `${results.trials} trials per case, ${results.durationMs / 1000}s each, first ${(results.runs[0]?.warmupMs ?? 0) / 1000}s excluded for warmup. Cases run sequentially; order reversed on alternating trials.`,
    "",
    "| Workload | Workers | Backend / slots | Samples | Median gap (ms) | p95 gap (ms) | Aggregate iterations/s | Scheduled executions/iteration |",
    "| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: |",
    ...rows.map(
      (r) =>
        `| ${r.mode === "busy" ? "Busy" : `Poll ${r.pollIntervalMs}ms`} | ${r.workers} | ${r.backend}${r.backend === "workpool" ? ` / ${r.maxParallelism}` : ""} | ${r.samples} | ${r.cadenceMs.p50.toFixed(1)} | ${r.cadenceMs.p95.toFixed(1)} | ${r.aggregateIterationsPerSec.mean.toFixed(1)} | ${r.scheduledExecutionsPerIteration.toFixed(2)} |`,
    ),
    "",
    "## Method",
    "",
    "These are minimal-loop measurements, not application throughput. Each query reads one fixed benchmark configuration row and logs a marker. Busy iterations call a no-op worker mutation and advance the existing cursor. Polling iterations return idle with the requested interval; one bootstrap batch starts the cooldown clock and is excluded. No per-iteration instrumentation writes are added.",
    "",
    "Intervals use successful outer mutation execution timestamps from Convex logs (scheduler loop or Workpool wrapper), grouped by named worker. Median and p95 pool all within-trial, within-worker intervals. Rates average the per-trial sum of worker rates. Scheduled-execution counts include the loop/wrapper, Workpool driver and completion functions; they exclude nested runQuery/runMutation calls and are not billing totals. The harness verifies contiguous busy iteration numbers and all workers return to idle.",
    "",
    "Both paths use the same app callbacks and deployment. Workpool uses a dedicated component, with no unrelated queued work. Timings include scheduler delay and database overhead, but exclude client request latency and the warmup window. Console logging and the fixed config read add equal instrumentation work to both paths. Results depend on deployment load and are not a service guarantee.",
    "",
    "## Reproduce",
    "",
    "```sh",
    "npm ci",
    "npm run build",
    "npx convex dev --once",
    "node execution-benchmark.mjs --duration-ms 10000 --trials 3",
    "```",
    "",
    "The runner requires a dev deployment, uses authenticated CLI calls to internal functions, and bounds each run to at most 60 seconds and 10 workers. Raw execution logs and timestamps are written alongside this report as executions.jsonl and results.json. Regenerate the report with `node execution-benchmark.mjs --summarize --out <output-directory>`.",
    "",
  ];
  writeFileSync(`${output}/report.md`, lines.join("\n"));
  console.log(lines.slice(6, 8 + rows.length).join("\n"));
}
