#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const compilerRoot = path.join(repositoryRoot, "packages/compiler");
const vitestPath = path.join(repositoryRoot, "node_modules/vitest/vitest.mjs");
const defaultWeightMs = 100;

// Unit weights come from the latest hosted core timing artifact. Codegen
// weights come from matching single-worker local runs because that lane did
// not previously publish per-file timings. Small and new files use the stable
// fallback; only material outliers need explicit weights.
const suites = {
  unit: {
    discoveryArgs: ["src", "--exclude", "src/codegen/**"],
    extraFiles: ["src/codegen/runtime/__tests__/resumptions.test.ts"],
    vitestArgs: [
      "--config",
      "../../vitest.config.ts",
      "--pool=forks",
      "--testTimeout",
      "60000",
      "--hookTimeout",
      "60000",
    ],
    weights: {
      "src/__tests__/call-shape-diagnostics.test.ts": 1000,
      "src/__tests__/dependency-snapshot-cache.test.ts": 826,
      "src/__tests__/diagnostic-spans.test.ts": 30076,
      "src/__tests__/effects-pkg-root.test.ts": 8204,
      "src/__tests__/macro-expansion.test.ts": 1160,
      "src/__tests__/memory-exports.test.ts": 680,
      "src/__tests__/module-codegen.test.ts": 3366,
      "src/__tests__/module-imports.test.ts": 946,
      "src/__tests__/module-typing.test.ts": 973,
      "src/__tests__/pipeline-api.test.ts": 1470,
      "src/__tests__/qualified-trait-methods-codegen.e2e.test.ts": 771,
      "src/__tests__/static-access.test.ts": 1905,
      "src/optimize/__tests__/pipeline-call-shape-planning.test.ts": 781,
      "src/optimize/__tests__/pipeline-integration.test.ts": 1139,
      "src/optimize/__tests__/pipeline-receiver-trait.test.ts": 834,
      "src/semantics/__tests__/pipeline.test.ts": 1210,
      "src/semantics/borrowing/__tests__/borrowing.test.ts": 6953,
      "src/semantics/borrowing/__tests__/callable-result-provenance.test.ts": 1270,
    },
  },
  codegen: {
    discoveryArgs: ["src/codegen"],
    extraFiles: [],
    vitestArgs: [
      "--config",
      "../../vitest.config.ts",
      "--testTimeout",
      "60000",
      "--hookTimeout",
      "60000",
    ],
    weights: {
      "src/codegen/__tests__/continuation-compiler.test.ts": 2436,
      "src/codegen/__tests__/effects-call-boundary.test.ts": 2430,
      "src/codegen/__tests__/effects-call-imported-callee.test.ts": 4436,
      "src/codegen/__tests__/effects-callback-after-perform.test.ts": 6482,
      "src/codegen/__tests__/effects-continuation-instances.test.ts": 2410,
      "src/codegen/__tests__/effects-explicit-id.test.ts": 4364,
      "src/codegen/__tests__/effects-export-generic-effect-decl.test.ts": 2238,
      "src/codegen/__tests__/effects-export-generic-op-arg.test.ts": 2395,
      "src/codegen/__tests__/effects-export-multi-return.test.ts": 2471,
      "src/codegen/__tests__/effects-export-object-arg-trap.test.ts": 2133,
      "src/codegen/__tests__/effects-export.test.ts": 13796,
      "src/codegen/__tests__/effects-generic-callback-sites.test.ts": 2267,
      "src/codegen/__tests__/effects-generic-escaped-closure-result.test.ts": 2288,
      "src/codegen/__tests__/effects-generic-wasm-e2e.test.ts": 2269,
      "src/codegen/__tests__/effects-handler-inferred-type-args.test.ts": 2155,
      "src/codegen/__tests__/effects-harness.test.ts": 12482,
      "src/codegen/__tests__/effects-hof-bubble.test.ts": 4524,
      "src/codegen/__tests__/effects-host-boundary-payload-compat.test.ts": 10327,
      "src/codegen/__tests__/effects-imported-std-fs-handler.test.ts": 1961,
      "src/codegen/__tests__/effects-multi-module-ids.test.ts": 2944,
      "src/codegen/__tests__/effects-perform.test.ts": 26126,
      "src/codegen/__tests__/effects-serializer-signature.test.ts": 4398,
      "src/codegen/__tests__/effects-signature-mismatch.test.ts": 2407,
      "src/codegen/__tests__/effects-wasm-e2e.test.ts": 15773,
      "src/codegen/__tests__/effects-wasm-object-arg.test.ts": 2144,
      "src/codegen/__tests__/export-abi.test.ts": 42750,
      "src/codegen/__tests__/range-for-fast-path.test.ts": 2271,
      "src/codegen/__tests__/shape-reification.test.ts": 3075,
      "src/codegen/__tests__/std-array-smoke.test.ts": 9119,
    },
  },
};

export const balanceWeightedFiles = ({
  files,
  shardCount,
  weights,
  fallbackWeight = defaultWeightMs,
}) => {
  if (!Number.isInteger(shardCount) || shardCount <= 0) {
    throw new Error("shard count must be a positive integer");
  }

  const shards = Array.from({ length: shardCount }, (_, index) => ({
    index,
    weightMs: 0,
    files: [],
  }));
  const weightedFiles = files
    .map((file) => ({ file, weightMs: weights[file] ?? fallbackWeight }))
    .sort(
      (left, right) =>
        right.weightMs - left.weightMs || left.file.localeCompare(right.file),
    );

  weightedFiles.forEach(({ file, weightMs }) => {
    const target = [...shards].sort(
      (left, right) =>
        left.weightMs - right.weightMs ||
        left.files.length - right.files.length ||
        left.index - right.index,
    )[0];
    target.files.push(file);
    target.weightMs += weightMs;
  });

  return shards.map(({ weightMs, files: shardFiles }) => ({
    weightMs,
    files: shardFiles.sort(),
  }));
};

export const parseShard = (value) => {
  const match = /^(\d+)\/(\d+)$/.exec(value ?? "1/1");
  if (!match) {
    throw new Error("--shard must use the format <index>/<count>");
  }
  const index = Number(match[1]);
  const count = Number(match[2]);
  if (index <= 0 || count <= 0 || index > count) {
    throw new Error("--shard index must be between one and the shard count");
  }
  return { index, count };
};

const optionValue = (args, name) => {
  const prefix = `${name}=`;
  const inline = args.find((argument) => argument.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const forwardedVitestArgs = (args) => {
  const forwarded = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--print-plan") continue;
    if (argument === "--suite" || argument === "--shard") {
      index += 1;
      continue;
    }
    if (argument.startsWith("--suite=") || argument.startsWith("--shard=")) {
      continue;
    }
    forwarded.push(argument);
  }
  return forwarded;
};

const discoverFiles = (suite) => {
  const result = spawnSync(
    process.execPath,
    [
      vitestPath,
      "list",
      ...suite.vitestArgs,
      ...suite.discoveryArgs,
      "--filesOnly",
    ],
    { cwd: compilerRoot, encoding: "utf8" },
  );
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    throw new Error("failed to discover compiler test files");
  }
  return [
    ...new Set([
      ...result.stdout
        .trim()
        .split(/\r?\n/)
        .map((file) => file.trim())
        .filter(Boolean),
      ...suite.extraFiles,
    ]),
  ];
};

const main = () => {
  const args = process.argv.slice(2);
  const suiteName = optionValue(args, "--suite");
  const suite = suites[suiteName];
  if (!suite) {
    throw new Error("--suite must be unit or codegen");
  }
  const shard = parseShard(
    optionValue(args, "--shard") ?? process.env.VOYD_COMPILER_TEST_SHARD,
  );
  const files = discoverFiles(suite);
  const plan = balanceWeightedFiles({
    files,
    shardCount: shard.count,
    weights: suite.weights,
  });
  const selected = plan[shard.index - 1];
  if (!selected || selected.files.length === 0) {
    throw new Error(
      `compiler ${suiteName} shard ${shard.index}/${shard.count} is empty`,
    );
  }
  if (args.includes("--print-plan")) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return;
  }

  process.stdout.write(
    `Running compiler ${suiteName} shard ${shard.index}/${shard.count}: ${selected.files.length} files, estimated weight ${selected.weightMs}ms\n`,
  );
  const result = spawnSync(
    process.execPath,
    [
      vitestPath,
      "run",
      ...suite.vitestArgs,
      ...selected.files,
      ...forwardedVitestArgs(args),
    ],
    { cwd: compilerRoot, env: process.env, stdio: "inherit" },
  );
  process.exitCode = result.status ?? 1;
};

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  main();
}
