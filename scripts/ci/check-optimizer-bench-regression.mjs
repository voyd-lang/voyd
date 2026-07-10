#!/usr/bin/env node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const DEFAULT_THRESHOLDS = {
  compile: { relativePct: 20, absolute: 250 },
  runtime: { relativePct: 20, absolute: 5 },
  rss: { relativePct: 15, absolute: 32 * 1024 * 1024 },
  wasm: { relativePct: 5, absolute: 1024 },
  gzip: { relativePct: 5, absolute: 512 },
};

const argValue = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const numericOption = ({ argument, environment, fallback }) => {
  const raw = argValue(argument) ?? process.env[environment];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${argument} must be a non-negative number`);
  }
  return value;
};

const thresholds = () => ({
  compile: {
    relativePct: numericOption({
      argument: "--compile-max-pct",
      environment: "OPTIMIZER_BENCH_COMPILE_MAX_PCT",
      fallback: DEFAULT_THRESHOLDS.compile.relativePct,
    }),
    absolute: numericOption({
      argument: "--compile-min-ms",
      environment: "OPTIMIZER_BENCH_COMPILE_MIN_MS",
      fallback: DEFAULT_THRESHOLDS.compile.absolute,
    }),
  },
  runtime: {
    relativePct: numericOption({
      argument: "--runtime-max-pct",
      environment: "OPTIMIZER_BENCH_RUNTIME_MAX_PCT",
      fallback: DEFAULT_THRESHOLDS.runtime.relativePct,
    }),
    absolute: numericOption({
      argument: "--runtime-min-ms",
      environment: "OPTIMIZER_BENCH_RUNTIME_MIN_MS",
      fallback: DEFAULT_THRESHOLDS.runtime.absolute,
    }),
  },
  rss: {
    relativePct: numericOption({
      argument: "--rss-max-pct",
      environment: "OPTIMIZER_BENCH_RSS_MAX_PCT",
      fallback: DEFAULT_THRESHOLDS.rss.relativePct,
    }),
    absolute: numericOption({
      argument: "--rss-min-bytes",
      environment: "OPTIMIZER_BENCH_RSS_MIN_BYTES",
      fallback: DEFAULT_THRESHOLDS.rss.absolute,
    }),
  },
  wasm: {
    relativePct: numericOption({
      argument: "--wasm-max-pct",
      environment: "OPTIMIZER_BENCH_WASM_MAX_PCT",
      fallback: DEFAULT_THRESHOLDS.wasm.relativePct,
    }),
    absolute: numericOption({
      argument: "--wasm-min-bytes",
      environment: "OPTIMIZER_BENCH_WASM_MIN_BYTES",
      fallback: DEFAULT_THRESHOLDS.wasm.absolute,
    }),
  },
  gzip: {
    relativePct: numericOption({
      argument: "--gzip-max-pct",
      environment: "OPTIMIZER_BENCH_GZIP_MAX_PCT",
      fallback: DEFAULT_THRESHOLDS.gzip.relativePct,
    }),
    absolute: numericOption({
      argument: "--gzip-min-bytes",
      environment: "OPTIMIZER_BENCH_GZIP_MIN_BYTES",
      fallback: DEFAULT_THRESHOLDS.gzip.absolute,
    }),
  },
});

const run = (command, args, label, options = {}) => {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: options.stdio ?? "inherit",
    env: options.env ?? process.env,
  });
  if (result.status !== 0) {
    const stderr = result.stderr?.trim();
    throw new Error(
      `${label} failed (exit ${result.status ?? "unknown"})${stderr ? `: ${stderr}` : ""}`,
    );
  }
  return result;
};

const capture = (command, args, label) =>
  run(command, args, label, { stdio: "pipe" }).stdout.trim();

const readScorecard = (filePath) => {
  const scorecard = JSON.parse(readFileSync(filePath, "utf8"));
  if (scorecard.schemaVersion !== 2 || !Array.isArray(scorecard.rows)) {
    throw new Error(`${filePath} is not an optimizer scorecard schema v2`);
  }
  return scorecard;
};

const rowKey = (row) =>
  `${row.scenario}\0${row.mode}\0${row.experiment ?? "baseline"}`;

const rowsByKey = (scorecard) =>
  new Map(scorecard.rows.map((row) => [rowKey(row), row]));

const rssComparisonBytes = (row) => {
  const samples = row.processMaxRssSamplesBytes ?? [];
  return samples.length > 0 ? Math.min(...samples) : row.processMaxRssBytes;
};

const percentDelta = (base, head) =>
  base === 0
    ? head === 0
      ? 0
      : Number.POSITIVE_INFINITY
    : ((head - base) / base) * 100;

const compareMetric = ({
  failures,
  scenario,
  label,
  base,
  head,
  threshold,
  metric,
  samples,
  format = (value) => value.toFixed(3),
}) => {
  const absoluteDelta = head - base;
  const relativeDelta = percentDelta(base, head);
  const failed =
    absoluteDelta > threshold.absolute && relativeDelta > threshold.relativePct;
  const marker = failed ? "FAIL" : "ok";
  console.log(
    `  [${marker}] ${label}: ${format(base)} -> ${format(head)} (${relativeDelta >= 0 ? "+" : ""}${relativeDelta.toFixed(2)}%, delta=${format(absoluteDelta)})`,
  );
  if (samples) {
    console.log(
      `    samples: base=[${samples.base.map(format).join(", ")}], head=[${samples.head.map(format).join(", ")}]`,
    );
  }
  if (failed) {
    failures.push({
      scenario,
      metric,
      message: `${scenario} ${label} regressed by ${relativeDelta.toFixed(2)}% / ${format(absoluteDelta)}`,
    });
  }
};

const changedRecordEntries = (base = {}, head = {}) => {
  const keys = new Set([...Object.keys(base), ...Object.keys(head)]);
  return [...keys].sort().flatMap((key) => {
    const before = base[key] ?? 0;
    const after = head[key] ?? 0;
    return before === after ? [] : [{ key, before, after }];
  });
};

const printOptimizerTelemetryChanges = ({ baseRow, headRow }) => {
  const passKey = (pass) => `${pass.slot}:${pass.name}`;
  const basePasses = new Map(
    (baseRow.optimizerPasses ?? []).map((pass) => [passKey(pass), pass]),
  );
  const headPasses = new Map(
    (headRow.optimizerPasses ?? []).map((pass) => [passKey(pass), pass]),
  );
  const keys = new Set([...basePasses.keys(), ...headPasses.keys()]);
  [...keys]
    .sort((left, right) => {
      const leftSlot = Number.parseInt(left.split(":", 1)[0], 10);
      const rightSlot = Number.parseInt(right.split(":", 1)[0], 10);
      return leftSlot - rightSlot || left.localeCompare(right);
    })
    .forEach((key) => {
      const before = basePasses.get(key);
      const after = headPasses.get(key);
      if (!before || !after) {
        console.log(
          `  [info] optimizer pass ${key}: ${before ? "removed" : "added"}`,
        );
        return;
      }
      const metricChanges = changedRecordEntries(before.metrics, after.metrics);
      const changedStateChanged = before.changed !== after.changed;
      const durationDeltaPct = percentDelta(before.medianMs, after.medianMs);
      const durationChangedMaterially =
        Math.abs(after.medianMs - before.medianMs) > 1 &&
        Math.abs(durationDeltaPct) > 10;
      if (
        !changedStateChanged &&
        metricChanges.length === 0 &&
        !durationChangedMaterially
      ) {
        return;
      }
      const details = [];
      if (changedStateChanged) {
        details.push(`changed=${before.changed}->${after.changed}`);
      }
      if (durationChangedMaterially) {
        details.push(
          `medianMs=${before.medianMs.toFixed(3)}->${after.medianMs.toFixed(3)} (${durationDeltaPct >= 0 ? "+" : ""}${durationDeltaPct.toFixed(1)}%)`,
        );
      }
      details.push(
        ...metricChanges.map(
          ({ key: metric, before: valueBefore, after: valueAfter }) =>
            `${metric}=${valueBefore}->${valueAfter}`,
        ),
      );
      console.log(`  [info] optimizer pass ${key}: ${details.join(", ")}`);
    });

  const codegenChanges = changedRecordEntries(
    baseRow.codegenMetrics,
    headRow.codegenMetrics,
  );
  if (codegenChanges.length > 0) {
    const displayed = codegenChanges.slice(0, 30);
    console.log(
      `  [info] codegen metrics: ${displayed
        .map(({ key, before, after }) => `${key}=${before}->${after}`)
        .join(", ")}`,
    );
    if (codegenChanges.length > displayed.length) {
      console.log(
        `  [info] codegen metrics: ${codegenChanges.length - displayed.length} additional changes omitted`,
      );
    }
  }
};

export const compareScorecards = ({ base, head, limits }) => {
  if (
    JSON.stringify(base.corpusHashes ?? {}) !==
    JSON.stringify(head.corpusHashes ?? {})
  ) {
    throw new Error(
      "optimizer scorecards were produced from different corpus sources",
    );
  }
  const baseRows = rowsByKey(base);
  const headRows = rowsByKey(head);
  const missing = [...baseRows.keys()].filter((key) => !headRows.has(key));
  const extra = [...headRows.keys()].filter((key) => !baseRows.has(key));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `optimizer scorecard cases differ; missing=[${missing.join(", ")}], extra=[${extra.join(", ")}]`,
    );
  }

  const failures = [];
  [...baseRows.keys()].sort().forEach((key) => {
    const baseRow = baseRows.get(key);
    const headRow = headRows.get(key);
    console.log(
      `\n${baseRow.scenario} (${baseRow.mode}, ${baseRow.experiment ?? "baseline"})`,
    );
    compareMetric({
      failures,
      scenario: baseRow.scenario,
      label: "compile median ms",
      base: baseRow.compileMedianMs,
      head: headRow.compileMedianMs,
      threshold: limits.compile,
      metric: "compile",
    });
    compareMetric({
      failures,
      scenario: baseRow.scenario,
      label: "runtime median ms",
      base: baseRow.runtimeMedianMs,
      head: headRow.runtimeMedianMs,
      threshold: limits.runtime,
      metric: "runtime",
    });
    compareMetric({
      failures,
      scenario: baseRow.scenario,
      label: "peak RSS clean sample MiB",
      base: rssComparisonBytes(baseRow),
      head: rssComparisonBytes(headRow),
      threshold: limits.rss,
      metric: "rss",
      samples: {
        base: baseRow.processMaxRssSamplesBytes ?? [],
        head: headRow.processMaxRssSamplesBytes ?? [],
      },
      format: (value) => (value / (1024 * 1024)).toFixed(2),
    });
    compareMetric({
      failures,
      scenario: baseRow.scenario,
      label: "wasm bytes",
      base: baseRow.wasmBytes,
      head: headRow.wasmBytes,
      threshold: limits.wasm,
      metric: "wasm",
      format: (value) => value.toFixed(0),
    });
    compareMetric({
      failures,
      scenario: baseRow.scenario,
      label: "gzip bytes",
      base: baseRow.gzipBytes,
      head: headRow.gzipBytes,
      threshold: limits.gzip,
      metric: "gzip",
      format: (value) => value.toFixed(0),
    });

    const structureKeys = new Set([
      ...Object.keys(baseRow.wasmStructure ?? {}),
      ...Object.keys(headRow.wasmStructure ?? {}),
    ]);
    const structuralChanges = [...structureKeys].sort().flatMap((name) => {
      const before = baseRow.wasmStructure?.[name] ?? 0;
      const after = headRow.wasmStructure?.[name] ?? 0;
      return before === after ? [] : [`${name}=${before}->${after}`];
    });
    if (structuralChanges.length > 0) {
      console.log(`  [info] wasm structure: ${structuralChanges.join(", ")}`);
    }
    printOptimizerTelemetryChanges({ baseRow, headRow });
  });

  return failures;
};

export const rssRetryScenarios = (failures) =>
  failures.length > 0 && failures.every(({ metric }) => metric === "rss")
    ? [...new Set(failures.map(({ scenario }) => scenario))]
    : [];

export const scorecardInputMode = ({
  baseJson,
  headJson,
  baseRef,
  headRef,
}) => {
  if (baseJson && headJson) {
    return "json";
  }
  return baseRef && headRef ? "refs" : undefined;
};

export const pairedRunOrder = ({
  scenarioNames,
  scenarioOrder = scenarioNames,
  baseRef,
  headRef,
  reverse = false,
}) =>
  scenarioNames.map((scenario) => {
    const index = scenarioOrder.indexOf(scenario);
    const baseFirst = (index % 2 === 0) !== reverse;
    return {
      scenario,
      refs: baseFirst ? [baseRef, headRef] : [headRef, baseRef],
    };
  });

const reportFailures = (failures) => {
  if (failures.length === 0) {
    console.log("\nOptimizer benchmark regression gate passed.");
    return;
  }
  console.error("\nOptimizer benchmark regression gate failed:");
  failures.forEach(({ message }) => console.error(`- ${message}`));
};

const mergedScorecard = (scorecards) => ({
  ...scorecards[0],
  generatedAt: new Date().toISOString(),
  corpusHashes: Object.assign(
    {},
    ...scorecards.map(({ corpusHashes }) => corpusHashes ?? {}),
  ),
  rows: scorecards.flatMap(({ rows }) => rows),
});

const replaceScenarios = ({ scorecard, replacement, scenarioNames }) => ({
  ...scorecard,
  generatedAt: new Date().toISOString(),
  corpusHashes: { ...scorecard.corpusHashes, ...replacement.corpusHashes },
  rows: [
    ...scorecard.rows.filter((row) => !scenarioNames.includes(row.scenario)),
    ...replacement.rows,
  ],
});

const benchmarkAtRefs = ({
  baseRef,
  headRef,
  tempRoot,
  scenarioNames: requestedScenarios,
  attempt,
}) => {
  const repoRoot = process.cwd();
  const resolvedBaseRef = capture(
    "git",
    ["rev-parse", baseRef],
    `resolve base ref ${baseRef}`,
  );
  const resolvedHeadRef = capture(
    "git",
    ["rev-parse", headRef],
    `resolve head ref ${headRef}`,
  );
  const harnessPath = path.join(repoRoot, "scripts", "bench-optimizer.ts");
  const harnessSource = readFileSync(harnessPath, "utf8");
  const plan = JSON.parse(
    capture(
      process.execPath,
      [
        "--conditions=development",
        "--import",
        "tsx",
        harnessPath,
        "--preset",
        "ci",
        "--print-plan",
      ],
      "read optimizer benchmark plan",
    ),
  );
  const scenarioNames = requestedScenarios ?? plan.scenarioNames;
  if (
    !Array.isArray(scenarioNames) ||
    scenarioNames.length === 0 ||
    scenarioNames.some((scenario) => !plan.scenarioNames.includes(scenario))
  ) {
    throw new Error("optimizer benchmark scenarios do not match the CI plan");
  }
  const corpusSnapshotPath = path.join(tempRoot, "corpus.json");
  const fixtureSources = {
    "std-math-transcendentals": readFileSync(
      path.join(
        repoRoot,
        "apps",
        "smoke",
        "fixtures",
        "std-math-transcendentals.voyd",
      ),
      "utf8",
    ),
    "vtrace-main": readFileSync(
      path.join(
        repoRoot,
        "apps",
        "smoke",
        "fixtures",
        "vtrace-compute-benchmark.voyd",
      ),
      "utf8",
    ),
    "effects-wide-return": readFileSync(
      path.join(
        repoRoot,
        "apps",
        "smoke",
        "fixtures",
        "optimized-wide-value-return.voyd",
      ),
      "utf8",
    ),
  };
  writeFileSync(corpusSnapshotPath, JSON.stringify(fixtureSources));
  const originalSha = capture("git", ["rev-parse", "HEAD"], "git rev-parse");
  const branchResult = spawnSync(
    "git",
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    { encoding: "utf8" },
  );
  const originalBranch =
    branchResult.status === 0 ? branchResult.stdout.trim() : undefined;
  const status = capture("git", ["status", "--porcelain"], "git status");
  if (status.length > 0 && process.env.CI !== "true") {
    throw new Error(
      "ref comparison requires a clean tracked working tree outside CI",
    );
  }
  const lockfileChanged =
    spawnSync("git", [
      "diff",
      "--quiet",
      resolvedBaseRef,
      resolvedHeadRef,
      "--",
      "package-lock.json",
    ]).status !== 0;

  const runAt = ({ ref, scenario, outputPath }) => {
    rmSync(harnessPath, { force: true });
    run("git", ["checkout", "--force", "--detach", ref], `checkout ${ref}`);
    writeFileSync(harnessPath, harnessSource);
    if (lockfileChanged) {
      run("npm", ["ci", "--include=optional"], `npm ci @ ${ref}`);
    }
    run(
      process.execPath,
      [
        "--conditions=development",
        "--import",
        "tsx",
        harnessPath,
        "--preset",
        "ci",
        "--scenarios",
        scenario,
        "--output",
        outputPath,
        "--corpus-snapshot",
        corpusSnapshotPath,
      ],
      `optimizer scorecard @ ${ref}`,
      { stdio: ["ignore", "ignore", "inherit"] },
    );
    rmSync(harnessPath, { force: true });
  };

  const scorecards = new Map([
    [resolvedBaseRef, []],
    [resolvedHeadRef, []],
  ]);
  const order = pairedRunOrder({
    scenarioNames,
    scenarioOrder: plan.scenarioNames,
    baseRef: resolvedBaseRef,
    headRef: resolvedHeadRef,
    reverse: attempt === "retry",
  });
  console.log(`\n${attempt} paired measurement order:`);
  order.forEach(({ scenario, refs }) =>
    console.log(`- ${scenario}: ${refs.join(" -> ")}`),
  );
  try {
    order.forEach(({ scenario, refs }, scenarioIndex) => {
      refs.forEach((ref, refIndex) => {
        const outputPath = path.join(
          tempRoot,
          `${attempt}-${scenarioIndex}-${refIndex}.json`,
        );
        runAt({ ref, scenario, outputPath });
        scorecards.get(ref).push(readScorecard(outputPath));
      });
    });
  } finally {
    rmSync(harnessPath, { force: true });
    const restoreArgs = originalBranch
      ? ["checkout", "--force", originalBranch]
      : ["checkout", "--force", "--detach", originalSha];
    run("git", restoreArgs, "restore original checkout");
    if (lockfileChanged) {
      run("npm", ["ci", "--include=optional"], "restore original dependencies");
    }
  }
  const basePath = path.join(tempRoot, `${attempt}-base.json`);
  const headPath = path.join(tempRoot, `${attempt}-head.json`);
  writeFileSync(
    basePath,
    `${JSON.stringify(mergedScorecard(scorecards.get(resolvedBaseRef)), null, 2)}\n`,
  );
  writeFileSync(
    headPath,
    `${JSON.stringify(mergedScorecard(scorecards.get(resolvedHeadRef)), null, 2)}\n`,
  );
  return { basePath, headPath };
};

const main = () => {
  const baseJson = argValue("--base-json");
  const headJson = argValue("--head-json");
  const baseRef = argValue("--base") ?? process.env.BASE_SHA;
  const headRef = argValue("--head") ?? process.env.HEAD_SHA;
  const tempRoot = mkdtempSync(path.join(tmpdir(), "voyd-optimizer-bench-"));
  try {
    const limits = thresholds();
    const inputMode = scorecardInputMode({
      baseJson,
      headJson,
      baseRef,
      headRef,
    });
    const paths =
      inputMode === "json"
        ? { basePath: baseJson, headPath: headJson }
        : inputMode === "refs"
          ? benchmarkAtRefs({
              baseRef,
              headRef,
              tempRoot,
              attempt: "initial",
            })
          : undefined;
    if (!paths) {
      throw new Error(
        "provide --base-json/--head-json or --base/--head (BASE_SHA/HEAD_SHA)",
      );
    }
    let finalBase = readScorecard(paths.basePath);
    let finalHead = readScorecard(paths.headPath);
    console.log("\nInitial paired comparison:");
    const initialFailures = compareScorecards({
      base: finalBase,
      head: finalHead,
      limits,
    });
    const retryScenarios = rssRetryScenarios(initialFailures);
    if (retryScenarios.length > 0 && inputMode === "refs") {
      console.log(
        `\nRSS was the only failing metric; retrying paired measurement for: ${retryScenarios.join(", ")}`,
      );
      const retryPaths = benchmarkAtRefs({
        baseRef,
        headRef,
        tempRoot,
        scenarioNames: retryScenarios,
        attempt: "retry",
      });
      const retryBase = readScorecard(retryPaths.basePath);
      const retryHead = readScorecard(retryPaths.headPath);
      finalBase = replaceScenarios({
        scorecard: finalBase,
        replacement: retryBase,
        scenarioNames: retryScenarios,
      });
      finalHead = replaceScenarios({
        scorecard: finalHead,
        replacement: retryHead,
        scenarioNames: retryScenarios,
      });
      console.log(
        "\nFinal paired comparison (RSS retries replace initial samples):",
      );
      const finalFailures = compareScorecards({
        base: finalBase,
        head: finalHead,
        limits,
      });
      reportFailures(finalFailures);
      process.exitCode = finalFailures.length > 0 ? 1 : 0;
      return;
    }
    if (retryScenarios.length > 0) {
      console.log(
        "\nRSS retry skipped because precomputed JSON scorecards were supplied.",
      );
    } else if (initialFailures.length > 0) {
      console.log(
        "\nRetry skipped because a deterministic metric also failed.",
      );
    }
    reportFailures(initialFailures);
    process.exitCode = initialFailures.length > 0 ? 1 : 0;
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
};

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
