#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const NODE_VERSION = "22.23.1";
const NPM_VERSION = "10.9.4";
const RECORDED_RUNTIME_SAMPLES = 5;
const EXTRA_RUNTIME_WARMUPS = 10;
const CORE_SCENARIOS = [
  "scalar-aggregate",
  "call-shape-defaults",
  "std-math-transcendentals",
  "tier1-trait-call",
];
const VTRACE_SCENARIO = "vtrace-main";

const option = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
};

const baseRef = option("--base", "v0.2.0");
const headRef = option("--head", "HEAD");
const outputPath = path.resolve(
  option("--output", "voyd-v0.3.0-release-benchmark.json"),
);
const repoRoot = process.cwd();
const tempRoot = mkdtempSync(path.join(tmpdir(), "voyd-release-bench-"));
const worktrees = [];

const run = (
  command,
  args,
  { cwd = repoRoot, label, stdio = "pipe", timeout } = {},
) => {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
    stdio,
    timeout,
  });
  if (result.status !== 0) {
    const detail =
      result.stderr?.trim() || result.error?.message || "no error output";
    throw new Error(`${label ?? command} failed: ${detail}`);
  }
  return result.stdout?.trim() ?? "";
};

const capture = (command, args, label) => run(command, args, { label });
const gitFile = (revision, file) =>
  capture(
    "git",
    ["show", `${revision}:${file}`],
    `read ${file} at ${revision}`,
  );
const nodeArgs = (args) => [
  "--yes",
  `--package=node@${NODE_VERSION}`,
  "--",
  "node",
  ...args,
];

const addWorktree = (name, revision) => {
  const directory = path.join(tempRoot, name);
  run("git", ["worktree", "add", "--detach", directory, revision], {
    label: `create ${name} worktree`,
    stdio: "inherit",
  });
  worktrees.push(directory);
  return directory;
};

const install = (directory, name) => {
  console.log(`Installing ${name} with npm ${NPM_VERSION}...`);
  run(
    "npx",
    [
      "--yes",
      `--package=npm@${NPM_VERSION}`,
      "--",
      "npm",
      "ci",
      "--include=optional",
    ],
    { cwd: directory, label: `install ${name}`, stdio: "inherit" },
  );
};

const runScorecard = ({
  directory,
  scenarios,
  corpusPath,
  output,
  modes = ["release"],
}) => {
  run(
    "npx",
    nodeArgs([
      "--conditions=development",
      "--import",
      "tsx",
      "scripts/bench-optimizer.ts",
      "--preset",
      "full",
      "--modes",
      modes.join(","),
      "--scenarios",
      scenarios.join(","),
      "--compile-warmups",
      "1",
      "--compile-samples",
      "3",
      "--runtime-samples",
      String(RECORDED_RUNTIME_SAMPLES + EXTRA_RUNTIME_WARMUPS),
      "--corpus-snapshot",
      corpusPath,
      "--output",
      output,
    ]),
    { cwd: directory, label: `benchmark ${path.basename(directory)}` },
  );
  const scorecard = JSON.parse(readFileSync(output, "utf8"));
  scorecard.rows = scorecard.rows.map((row) => {
    const runtimeSamplesMs = row.runtimeSamplesMs.slice(
      -RECORDED_RUNTIME_SAMPLES,
    );
    return {
      ...row,
      runtimeMedianMs: median(runtimeSamplesMs),
      runtimeSamplesMs,
    };
  });
  return scorecard;
};

const rowsByScenario = (scorecard) =>
  Object.fromEntries(
    scorecard.rows.map((row) => [`${row.scenario}:${row.mode}`, row]),
  );

const percentChange = (base, head) => ((head - base) / base) * 100;

const median = (values) => {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
};

const comparison = ({ base, head }) => ({
  base,
  head,
  percentChange: percentChange(base, head),
});

const compareRows = ({ base, head }) => ({
  compileMs: comparison({
    base: base.compileMedianMs,
    head: head.compileMedianMs,
  }),
  runtimeMs: comparison({
    base: base.runtimeMedianMs,
    head: head.runtimeMedianMs,
  }),
  wasmBytes: comparison({ base: base.wasmBytes, head: head.wasmBytes }),
  gzipBytes: comparison({ base: base.gzipBytes, head: head.gzipBytes }),
  samples: {
    base: {
      compileMs: base.compileSamplesMs,
      runtimeMs: base.runtimeSamplesMs,
    },
    head: {
      compileMs: head.compileSamplesMs,
      runtimeMs: head.runtimeSamplesMs,
    },
  },
});

const compareOptimizationRows = ({ unoptimized, release }) => ({
  compileMs: {
    unoptimized: unoptimized.compileMedianMs,
    release: release.compileMedianMs,
    percentChange: percentChange(
      unoptimized.compileMedianMs,
      release.compileMedianMs,
    ),
  },
  runtimeMs: {
    unoptimized: unoptimized.runtimeMedianMs,
    release: release.runtimeMedianMs,
    speedup: unoptimized.runtimeMedianMs / release.runtimeMedianMs,
    percentChange: percentChange(
      unoptimized.runtimeMedianMs,
      release.runtimeMedianMs,
    ),
  },
  wasmBytes: {
    unoptimized: unoptimized.wasmBytes,
    release: release.wasmBytes,
    percentChange: percentChange(unoptimized.wasmBytes, release.wasmBytes),
  },
  gzipBytes: {
    unoptimized: unoptimized.gzipBytes,
    release: release.gzipBytes,
    percentChange: percentChange(unoptimized.gzipBytes, release.gzipBytes),
  },
  samples: {
    unoptimized: {
      compileMs: unoptimized.compileSamplesMs,
      runtimeMs: unoptimized.runtimeSamplesMs,
    },
    release: {
      compileMs: release.compileSamplesMs,
      runtimeMs: release.runtimeSamplesMs,
    },
  },
});

try {
  const baseRevision = capture(
    "git",
    ["rev-parse", baseRef],
    `resolve ${baseRef}`,
  );
  const headRevision = capture(
    "git",
    ["rev-parse", headRef],
    `resolve ${headRef}`,
  );
  const baseDirectory = addWorktree("base", baseRevision);
  const headDirectory = addWorktree("head", headRevision);

  const harness = gitFile(headRevision, "scripts/bench-optimizer.ts");
  writeFileSync(
    path.join(baseDirectory, "scripts", "bench-optimizer.ts"),
    harness,
  );
  writeFileSync(
    path.join(headDirectory, "scripts", "bench-optimizer.ts"),
    harness,
  );

  const corpus = {
    "std-math-transcendentals": gitFile(
      headRevision,
      "tests/integration/fixtures/std-math-transcendentals.voyd",
    ),
    "vtrace-main": gitFile(
      headRevision,
      "tests/performance/fixtures/vtrace-compute-benchmark.voyd",
    ),
  };
  const corpusPath = path.join(tempRoot, "corpus.json");
  writeFileSync(corpusPath, JSON.stringify(corpus));

  install(baseDirectory, baseRef);
  install(headDirectory, headRef);

  console.log("Running representative release workloads...");
  const baseScorecard = runScorecard({
    directory: baseDirectory,
    scenarios: CORE_SCENARIOS,
    corpusPath,
    output: path.join(tempRoot, "base-core.json"),
  });
  const headScorecard = runScorecard({
    directory: headDirectory,
    scenarios: CORE_SCENARIOS,
    corpusPath,
    output: path.join(tempRoot, "head-core.json"),
    modes: ["unoptimized", "release"],
  });

  console.log("Running Gaia BH1 vtrace scorecard...");
  const headVtrace = runScorecard({
    directory: headDirectory,
    scenarios: [VTRACE_SCENARIO],
    corpusPath,
    output: path.join(tempRoot, "head-vtrace.json"),
  }).rows[0];

  const baseRows = rowsByScenario(baseScorecard);
  const headRows = rowsByScenario(headScorecard);
  const scenarios = Object.fromEntries(
    CORE_SCENARIOS.map((name) => [
      name,
      compareRows({
        base: baseRows[`${name}:release`],
        head: headRows[`${name}:release`],
      }),
    ]),
  );
  const gaiaOptimization = Object.fromEntries(
    CORE_SCENARIOS.map((name) => [
      name,
      compareOptimizationRows({
        unoptimized: headRows[`${name}:unoptimized`],
        release: headRows[`${name}:release`],
      }),
    ]),
  );
  const result = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    environment: {
      platform: `${process.platform}-${process.arch}`,
      node: NODE_VERSION,
      packageManager: `npm ${NPM_VERSION}`,
      compileWarmups: 1,
      compileSamples: 3,
      runtimeWarmups: 1 + EXTRA_RUNTIME_WARMUPS,
      runtimeSamples: RECORDED_RUNTIME_SAMPLES,
    },
    revisions: {
      base: { ref: baseRef, revision: baseRevision },
      head: { ref: headRef, revision: headRevision },
    },
    corpusHashes: headScorecard.corpusHashes,
    scenarios,
    gaiaOptimization,
    vtrace: {
      head: {
        compileMedianMs: headVtrace.compileMedianMs,
        compileSamplesMs: headVtrace.compileSamplesMs,
        runtimeMedianMs: headVtrace.runtimeMedianMs,
        runtimeSamplesMs: headVtrace.runtimeSamplesMs,
        wasmBytes: headVtrace.wasmBytes,
        gzipBytes: headVtrace.gzipBytes,
      },
    },
  };

  writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`Benchmark results written to ${outputPath}`);
  Object.entries(scenarios).forEach(([name, metrics]) => {
    const speedup = metrics.runtimeMs.base / metrics.runtimeMs.head;
    console.log(
      `${name}: ${speedup.toFixed(2)}x runtime, ${metrics.wasmBytes.percentChange.toFixed(1)}% Wasm`,
    );
  });
  ["scalar-aggregate", "call-shape-defaults"].forEach((name) => {
    const metrics = gaiaOptimization[name];
    console.log(
      `${name} release profile: ${metrics.runtimeMs.speedup.toFixed(2)}x runtime, ${metrics.wasmBytes.percentChange.toFixed(1)}% Wasm`,
    );
  });
  console.log(
    `vtrace: ${headVtrace.runtimeMedianMs.toFixed(1)} ms on ${headRef}`,
  );
} finally {
  worktrees.reverse().forEach((directory) => {
    spawnSync("git", ["worktree", "remove", "--force", directory], {
      cwd: repoRoot,
      stdio: "ignore",
    });
  });
  rmSync(tempRoot, { recursive: true, force: true });
}
