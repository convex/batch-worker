#!/usr/bin/env node
// Query values -> Promise.all patches vs query IDs -> Promise.all gets -> Promise.all patches.
// Usage: node benchmark.mjs [--trials 50] [--batch-sizes 1,25,100]
import { spawn, execFile } from "node:child_process";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { parseArgs, parseEnv, promisify } from "node:util";

const { values } = parseArgs({
  options: {
    trials: { type: "string", default: "50" },
    warmups: { type: "string", default: "5" },
    "batch-sizes": { type: "string", default: "1,25,100" },
    "padding-bytes": { type: "string", default: "0,4096" },
    output: {
      type: "string",
      default: ".context/benchmark-parallel-patches-results",
    },
  },
});
const env = parseEnv(readFileSync(".env.local", "utf8"));
const deployment = env.CONVEX_DEPLOYMENT?.match(/^dev:([\w-]+)$/)?.[1];
if (!deployment || process.env.CONVEX_DEPLOY_KEY || env.CONVEX_DEPLOY_KEY) {
  throw new Error(
    "This harness requires a dev deployment in .env.local and no deploy-key override.",
  );
}
const trials = Number(values.trials);
const warmups = Number(values.warmups);
const batchSizes = values["batch-sizes"].split(",").map(Number);
const paddingSizes = values["padding-bytes"].split(",").map(Number);
for (const [numbers, min, max] of [
  [batchSizes, 1, 500],
  [paddingSizes, 0, 16384],
  [[trials], 1, 100],
  [[warmups], 0, 20],
]) {
  if (numbers.some((n) => !Number.isInteger(n) || n < min || n > max)) {
    throw new Error(`Expected integers from ${min} to ${max}`);
  }
}
const outDir = values.output;
mkdirSync(outDir, { recursive: true });
const runId = randomUUID();
const cli = "node_modules/convex/bin/main.js";
const exec = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const events = [];
const cases = [];
const tagPattern =
  /batch-read-bench\|([\w-]+)\|(\d+)\|(\d+)\|(-?\d+)\|(patch|refetch)\|(true|false)/;

function completions() {
  const unique = new Map();
  for (const event of events) {
    if (
      event.kind !== "Completion" ||
      event.identifier?.replace(".js:", ":") !== "benchmark:iteration"
    )
      continue;
    const tag = JSON.stringify(event.logLines).match(tagPattern);
    if (!tag || !tag[1].startsWith(runId)) continue;
    unique.set(event.executionId, {
      ...event,
      caseId: tag[1],
      batchSize: +tag[2],
      paddingBytes: +tag[3],
      trial: +tag[4],
      mode: tag[5],
      warmup: tag[6] === "true",
    });
  }
  return [...unique.values()];
}

function stats(xs) {
  if (!xs.length) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return {
    n: xs.length,
    mean,
    p50: sorted[Math.floor(xs.length * 0.5)],
    p95: sorted[Math.min(xs.length - 1, Math.floor(xs.length * 0.95))],
  };
}

function summarize(samples) {
  return {
    executionMs: stats(samples.map((e) => e.executionTime * 1000)),
    readDocuments: stats(
      samples.map((e) => e.usageStats.databaseReadDocuments),
    ),
    readBytes: stats(samples.map((e) => e.usageStats.databaseReadBytes)),
    writeBytes: stats(samples.map((e) => e.usageStats.databaseWriteBytes)),
  };
}

console.log(
  `Target: dev (${deployment}); ${trials} paired trials, ${warmups} warmup pairs per case.`,
);
const logProcess = spawn(
  process.execPath,
  [cli, "logs", "--deployment", deployment, "--jsonl", "--success"],
  { stdio: ["ignore", "pipe", "pipe"] },
);
let buffer = "";
let logError = "";
logProcess.stderr.on("data", (chunk) => {
  logError += chunk.toString();
});
logProcess.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line.startsWith("{")) events.push(JSON.parse(line));
  }
});

try {
  await sleep(2000);
  if (logProcess.exitCode !== null)
    throw new Error(`Log stream exited: ${logError}`);
  for (const paddingBytes of paddingSizes) {
    for (const batchSize of batchSizes) {
      const caseId = `${runId}-${batchSize}-${paddingBytes}`;
      const args = { runId: caseId, batchSize, paddingBytes, trials, warmups };
      const { stdout } = await exec(
        process.execPath,
        [
          cli,
          "run",
          "--deployment",
          deployment,
          "benchmark:run",
          JSON.stringify(args),
        ],
        { maxBuffer: 32 * 1024 * 1024 },
      );
      const actionSamples = JSON.parse(stdout);
      cases.push({ caseId, batchSize, paddingBytes, actionSamples });
      writeFileSync(`${outDir}/cases.json`, JSON.stringify(cases, null, 2));
      console.log(
        `Verified ${batchSize} rows/batch, ${paddingBytes} padding bytes: ${actionSamples.length} measured executions; fixtures cleaned up.`,
      );
    }
  }
  const expected = cases.length * trials * 2;
  const deadline = Date.now() + 30000;
  while (
    completions().filter((e) => !e.warmup && !e.error && !e.willRetry).length <
      expected &&
    Date.now() < deadline
  )
    await sleep(500);
  const measured = completions().filter(
    (e) => !e.warmup && !e.error && !e.willRetry,
  );
  if (measured.length !== expected)
    throw new Error(
      `Expected ${expected} completion logs, got ${measured.length}. ${logError}`,
    );
  const results = cases.map((spec) => {
    const samples = measured.filter((e) => e.caseId === spec.caseId);
    const patch = samples
      .filter((e) => e.mode === "patch")
      .sort((a, b) => a.trial - b.trial);
    const refetch = samples
      .filter((e) => e.mode === "refetch")
      .sort((a, b) => a.trial - b.trial);
    for (const rows of [patch, refetch]) {
      if (rows.length !== trials || rows.some((e, i) => e.trial !== i))
        throw new Error("Missing or duplicated trial logs");
    }
    const diffs = refetch.map(
      (e, i) => (e.executionTime - patch[i].executionTime) * 1000,
    );
    const mean = stats(diffs).mean;
    const se =
      trials > 1
        ? Math.sqrt(
            diffs.reduce((sum, d) => sum + (d - mean) ** 2, 0) /
              (trials - 1) /
              trials,
          )
        : null;
    return {
      batchSize: spec.batchSize,
      paddingBytes: spec.paddingBytes,
      patch: summarize(patch),
      refetch: summarize(refetch),
      pairedDifferenceMs: {
        mean,
        normalApprox95CI:
          se === null ? null : [mean - 1.96 * se, mean + 1.96 * se],
      },
      actionRoundTripMs: Object.fromEntries(
        ["patch", "refetch"].map((mode) => [
          mode,
          stats(
            spec.actionSamples
              .filter((s) => s.mode === mode)
              .map((s) => s.elapsedMs),
          ),
        ]),
      ),
    };
  });
  const report = {
    createdAt: new Date().toISOString(),
    deployment,
    runId,
    trials,
    warmups,
    patchStrategy: "Promise.all patches",
    refetchStrategy: "Promise.all gets, then Promise.all patches",
    convexVersion: JSON.parse(
      readFileSync("node_modules/convex/package.json", "utf8"),
    ).version,
    errorsOrRetries: completions().filter(
      (e) => e.error || e.willRetry || e.occInfo?.retryCount,
    ).length,
    results,
  };
  writeFileSync(`${outDir}/results.json`, JSON.stringify(report, null, 2));
  console.table(
    results.map((r) => ({
      batch: r.batchSize,
      padding: r.paddingBytes,
      "patch mean ms": r.patch.executionMs.mean.toFixed(3),
      "refetch mean ms": r.refetch.executionMs.mean.toFixed(3),
      "difference ms": r.pairedDifferenceMs.mean.toFixed(3),
      "patch reads": r.patch.readDocuments.mean,
      "refetch reads": r.refetch.readDocuments.mean,
    })),
  );
  console.log(`Wrote ${outDir}/results.json`);
} finally {
  logProcess.kill("SIGTERM");
  writeFileSync(
    `${outDir}/logs.jsonl`,
    events.map((e) => JSON.stringify(e)).join("\n") + "\n",
  );
}
