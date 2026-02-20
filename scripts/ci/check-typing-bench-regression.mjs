#!/usr/bin/env node
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const DEFAULT_MAX_REGRESSION_PCT = 15;

const parseArgs = () => {
  const args = process.argv.slice(2);
  const get = (name) => {
    const idx = args.findIndex((value) => value === name);
    return idx >= 0 ? args[idx + 1] : undefined;
  };

  const base = get("--base") ?? process.env.BASE_SHA;
  const head = get("--head") ?? process.env.HEAD_SHA;
  const maxRegressionRaw =
    get("--max-regression-pct") ?? process.env.TYPING_BENCH_MAX_REGRESSION_PCT;
  const maxRegression = Number(maxRegressionRaw ?? DEFAULT_MAX_REGRESSION_PCT);

  if (!base || !head) {
    throw new Error(
      "Missing refs. Provide --base/--head (or BASE_SHA/HEAD_SHA env vars)."
    );
  }
  if (!Number.isFinite(maxRegression) || maxRegression < 0) {
    throw new Error("max regression percent must be a non-negative number.");
  }

  return { base, head, maxRegression };
};

const run = (cmd, argv, label) => {
  const result = spawnSync(cmd, argv, {
    stdio: "inherit",
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`${label} failed (exit ${result.status ?? "unknown"}).`);
  }
};

const runCapture = (cmd, argv, label) => {
  const result = spawnSync(cmd, argv, { encoding: "utf8" });
  if (result.status !== 0) {
    const stderr = result.stderr?.trim();
    throw new Error(
      `${label} failed (exit ${result.status ?? "unknown"})${stderr ? `: ${stderr}` : "."}`
    );
  }
  return result.stdout.trim();
};

const ensureSafeCheckout = () => {
  const status = runCapture("git", ["status", "--porcelain"], "git status");
  if (status.length > 0 && process.env.CI !== "true") {
    throw new Error(
      "Working tree is dirty. Refusing to checkout refs outside CI because it would overwrite local changes."
    );
  }
};

const checkout = (ref) => {
  run("git", ["checkout", "--force", "--detach", ref], `git checkout ${ref}`);
};

const parseBenchmarkMeans = (outputPath) => {
  const parsed = JSON.parse(readFileSync(outputPath, "utf8"));
  const benchmarks = parsed?.files?.flatMap((file) =>
    (file?.groups ?? []).flatMap((group) => group?.benchmarks ?? [])
  );
  if (!Array.isArray(benchmarks) || benchmarks.length === 0) {
    throw new Error(`No benchmark results found in ${outputPath}.`);
  }
  return new Map(
    benchmarks.map((bench) => [
      bench.name,
      {
        mean: Number(bench.mean),
        hz: Number(bench.hz),
      },
    ])
  );
};

const runBenchAtRef = ({ ref, outputPath }) => {
  checkout(ref);
  run(
    "npm",
    [
      "run",
      "--workspace",
      "@voyd/compiler",
      "bench:typing",
      "--",
      `--outputJson=${outputPath}`,
    ],
    `bench:typing @ ${ref}`
  );
  return parseBenchmarkMeans(outputPath);
};

const compare = ({ baseResults, headResults, maxRegression }) => {
  const names = [...baseResults.keys()].sort();
  const missing = names.filter((name) => !headResults.has(name));
  if (missing.length > 0) {
    throw new Error(
      `Head benchmark output is missing cases: ${missing.join(", ")}`
    );
  }

  const extra = [...headResults.keys()].filter((name) => !baseResults.has(name));
  if (extra.length > 0) {
    throw new Error(
      `Head benchmark output has unexpected extra cases: ${extra.join(", ")}`
    );
  }

  const regressions = [];
  console.log("Typing benchmark comparison (lower mean is better):");
  names.forEach((name) => {
    const base = baseResults.get(name);
    const head = headResults.get(name);
    const deltaPct = ((head.mean - base.mean) / base.mean) * 100;
    const deltaLabel = `${deltaPct >= 0 ? "+" : ""}${deltaPct.toFixed(2)}%`;
    console.log(
      `- ${name}: base=${base.mean.toFixed(4)}ms head=${head.mean.toFixed(4)}ms delta=${deltaLabel}`
    );
    if (deltaPct > maxRegression) {
      regressions.push({ name, deltaPct, baseMean: base.mean, headMean: head.mean });
    }
  });

  if (regressions.length > 0) {
    console.error(
      `\nTyping benchmark regression gate failed (threshold: +${maxRegression.toFixed(2)}%).`
    );
    regressions.forEach((entry) => {
      console.error(
        `- ${entry.name}: ${entry.baseMean.toFixed(4)}ms -> ${entry.headMean.toFixed(4)}ms (+${entry.deltaPct.toFixed(2)}%)`
      );
    });
    process.exit(1);
  }

  console.log(
    `\nTyping benchmark regression gate passed (threshold: +${maxRegression.toFixed(2)}%).`
  );
};

const main = () => {
  const { base, head, maxRegression } = parseArgs();
  ensureSafeCheckout();
  const originalRef = runCapture("git", ["rev-parse", "--verify", "HEAD"], "git rev-parse");
  const tmpRoot = mkdtempSync(join(tmpdir(), "typing-bench-"));
  const baseOutput = join(tmpRoot, "base.json");
  const headOutput = join(tmpRoot, "head.json");

  try {
    console.log(`Comparing typing benchmark: base=${base} head=${head}`);
    const baseResults = runBenchAtRef({ ref: base, outputPath: baseOutput });
    const headResults = runBenchAtRef({ ref: head, outputPath: headOutput });
    compare({ baseResults, headResults, maxRegression });
  } finally {
    try {
      checkout(originalRef);
    } catch (error) {
      console.error(`Failed to restore original ref ${originalRef}:`, error);
      process.exitCode = 1;
    }
    rmSync(tmpRoot, { recursive: true, force: true });
  }
};

main();
