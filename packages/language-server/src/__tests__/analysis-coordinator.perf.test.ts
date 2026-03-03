import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { TextDocument } from "vscode-languageserver-textdocument";
import { analyzeProjectCore, resolveModuleRoots, toFileUri } from "../project.js";
import { AnalysisCoordinator } from "../server/analysis-coordinator.js";

const runPerf = process.env.VOYD_LS_PERF === "1";
const perfIt = runPerf ? it : it.skip;

type PerfScenario = {
  name: string;
  moduleCount: number;
  functionsPerModule: number;
};

type BenchmarkSummary = {
  medianPostEditMs: number;
  peakRssDeltaMb: number;
};

const MB = 1024 * 1024;

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const middleValue = sorted[middle];
  if (middleValue === undefined) {
    return 0;
  }

  return sorted.length % 2 === 0 && sorted[middle - 1] !== undefined
    ? (middleValue + sorted[middle - 1]!) / 2
    : middleValue;
};

const rssMb = (): number => process.memoryUsage().rss / MB;

const runGc = (): void => {
  if (typeof global.gc !== "function") {
    return;
  }
  global.gc();
};

const parseScenarios = (value: string | undefined): PerfScenario[] => {
  if (!value) {
    return [
      { name: "100k", moduleCount: 400, functionsPerModule: 85 },
      { name: "300k", moduleCount: 1100, functionsPerModule: 90 },
    ];
  }

  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const [name, moduleCountText, functionsPerModuleText] = entry.split(":");
      const moduleCount = Number.parseInt(moduleCountText ?? "", 10);
      const functionsPerModule = Number.parseInt(functionsPerModuleText ?? "", 10);
      if (!name || !Number.isFinite(moduleCount) || !Number.isFinite(functionsPerModule)) {
        throw new Error(
          `Invalid VOYD_LS_PERF_SCENARIOS entry "${entry}". Expected format: name:moduleCount:functionsPerModule`,
        );
      }

      return {
        name,
        moduleCount,
        functionsPerModule,
      };
    });
};

const moduleSource = ({
  moduleIndex,
  functionsPerModule,
}: {
  moduleIndex: number;
  functionsPerModule: number;
}): string =>
  Array.from({ length: functionsPerModule }, (_entry, functionIndex) => {
    const value = moduleIndex * 10_000 + functionIndex;
    return `pub fn mod_${moduleIndex}_fn_${functionIndex}() -> i32\n  ${value}\n`;
  }).join("\n");

const buildCoreSource = ({
  moduleCount,
}: {
  moduleCount: number;
}): string => {
  const useLines = Array.from(
    { length: moduleCount },
    (_entry, moduleIndex) =>
      `use src::mod_${moduleIndex}::mod_${moduleIndex}_fn_0`,
  ).join("\n");
  const sumExpression = Array.from(
    { length: moduleCount },
    (_entry, moduleIndex) => `mod_${moduleIndex}_fn_0()`,
  ).join(" + ");

  return `${useLines}\n\npub fn total() -> i32\n  ${sumExpression}\n`;
};

const createPerfProject = async ({
  moduleCount,
  functionsPerModule,
}: {
  moduleCount: number;
  functionsPerModule: number;
}): Promise<{
  rootDir: string;
  entryPath: string;
  entryUri: string;
  modulePathFor: (moduleIndex: number) => string;
  moduleUriFor: (moduleIndex: number) => string;
  moduleSourceFor: (moduleIndex: number, run: number) => string;
}> => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "voyd-ls-perf-"));
  const srcDir = path.join(rootDir, "src");
  await mkdir(srcDir, { recursive: true });

  await Promise.all(
    Array.from({ length: moduleCount }, (_entry, moduleIndex) =>
      writeFile(
        path.join(srcDir, `mod_${moduleIndex}.voyd`),
        moduleSource({
          moduleIndex,
          functionsPerModule,
        }),
        "utf8",
      ),
    ),
  );

  await writeFile(
    path.join(srcDir, "core.voyd"),
    buildCoreSource({ moduleCount }),
    "utf8",
  );
  await writeFile(
    path.join(srcDir, "main.voyd"),
    `use src::core::total\n\nfn main() -> i32\n  total()\n`,
    "utf8",
  );

  const moduleSourceFor = (moduleIndex: number, run: number): string => {
    const functions = Array.from({ length: functionsPerModule }, (_entry, functionIndex) => {
      const value =
        functionIndex === 0
          ? 1_000_000 + run + moduleIndex
          : moduleIndex * 10_000 + functionIndex;
      return `pub fn mod_${moduleIndex}_fn_${functionIndex}() -> i32\n  ${value}\n`;
    });
    return `${functions.join("\n")}\n`;
  };

  return {
    rootDir,
    entryPath: path.join(srcDir, "main.voyd"),
    entryUri: toFileUri(path.join(srcDir, "main.voyd")),
    modulePathFor: (moduleIndex: number) => path.join(srcDir, `mod_${moduleIndex}.voyd`),
    moduleUriFor: (moduleIndex: number) =>
      toFileUri(path.join(srcDir, `mod_${moduleIndex}.voyd`)),
    moduleSourceFor,
  };
};

const benchmarkBaseline = async ({
  entryPath,
  modulePathFor,
  moduleSourceFor,
  moduleCount,
  editRuns,
}: {
  entryPath: string;
  modulePathFor: (moduleIndex: number) => string;
  moduleSourceFor: (moduleIndex: number, run: number) => string;
  moduleCount: number;
  editRuns: number;
}): Promise<BenchmarkSummary> => {
  const roots = resolveModuleRoots(entryPath);
  const warmModulePath = modulePathFor(0);
  const warmOpenDocuments = new Map<string, string>([[warmModulePath, moduleSourceFor(0, 0)]]);

  await analyzeProjectCore({
    entryPath,
    roots,
    openDocuments: warmOpenDocuments,
  });

  runGc();
  const rssStart = rssMb();
  let peakRss = rssStart;
  const editDurations: number[] = [];

  for (let run = 0; run < editRuns; run += 1) {
    const moduleIndex = run % Math.max(1, moduleCount);
    const modulePath = modulePathFor(moduleIndex);
    const openDocuments = new Map<string, string>([
      [modulePath, moduleSourceFor(moduleIndex, run + 1)],
    ]);
    const start = performance.now();
    await analyzeProjectCore({
      entryPath,
      roots,
      openDocuments,
    });
    editDurations.push(performance.now() - start);
    peakRss = Math.max(peakRss, rssMb());
  }

  return {
    medianPostEditMs: median(editDurations),
    peakRssDeltaMb: Math.max(0, peakRss - rssStart),
  };
};

const benchmarkIncremental = async ({
  entryUri,
  moduleUriFor,
  moduleSourceFor,
  moduleCount,
  editRuns,
}: {
  entryUri: string;
  moduleUriFor: (moduleIndex: number) => string;
  moduleSourceFor: (moduleIndex: number, run: number) => string;
  moduleCount: number;
  editRuns: number;
}): Promise<BenchmarkSummary> => {
  const coordinator = new AnalysisCoordinator();
  await coordinator.getCoreForUri(entryUri);

  runGc();
  const rssStart = rssMb();
  let peakRss = rssStart;
  const editDurations: number[] = [];

  for (let run = 0; run < editRuns; run += 1) {
    const moduleIndex = run % Math.max(1, moduleCount);
    const moduleUri = moduleUriFor(moduleIndex);
    coordinator.updateDocument(
      TextDocument.create(
        moduleUri,
        "voyd",
        run + 1,
        moduleSourceFor(moduleIndex, run + 1),
      ),
    );
    const start = performance.now();
    await coordinator.getCoreForUri(entryUri);
    editDurations.push(performance.now() - start);
    peakRss = Math.max(peakRss, rssMb());
  }

  return {
    medianPostEditMs: median(editDurations),
    peakRssDeltaMb: Math.max(0, peakRss - rssStart),
  };
};

describe("analysis coordinator perf harness", () => {
  perfIt(
    "meets post-edit speed and RSS targets against full recompute baseline",
    async () => {
      const editRuns = Number.parseInt(process.env.VOYD_LS_PERF_EDIT_RUNS ?? "5", 10);
      const configuredMinSpeedup = Number.parseFloat(
        process.env.VOYD_LS_PERF_MIN_SPEEDUP ?? "5",
      );
      const configuredMinRssReductionPct = Number.parseFloat(
        process.env.VOYD_LS_PERF_MIN_RSS_REDUCTION_PCT ?? "30",
      );
      const minSpeedup = Math.max(5, configuredMinSpeedup);
      const minRssReductionPct = Math.max(30, configuredMinRssReductionPct);
      const scenarios = parseScenarios(process.env.VOYD_LS_PERF_SCENARIOS);

      for (const scenario of scenarios) {
        const project = await createPerfProject({
          moduleCount: scenario.moduleCount,
          functionsPerModule: scenario.functionsPerModule,
        });

        try {
          const baseline = await benchmarkBaseline({
            entryPath: project.entryPath,
            modulePathFor: project.modulePathFor,
            moduleSourceFor: project.moduleSourceFor,
            moduleCount: scenario.moduleCount,
            editRuns,
          });
          const incremental = await benchmarkIncremental({
            entryUri: project.entryUri,
            moduleUriFor: project.moduleUriFor,
            moduleSourceFor: project.moduleSourceFor,
            moduleCount: scenario.moduleCount,
            editRuns,
          });

          const speedup =
            baseline.medianPostEditMs / Math.max(1, incremental.medianPostEditMs);
          const rssReductionPct =
            baseline.peakRssDeltaMb > 0
              ? ((baseline.peakRssDeltaMb - incremental.peakRssDeltaMb) /
                  baseline.peakRssDeltaMb) *
                100
              : 100;

          console.info(
            `[ls-perf] scenario=${scenario.name} modules=${scenario.moduleCount} funcsPerModule=${scenario.functionsPerModule} baselineMedianMs=${baseline.medianPostEditMs.toFixed(2)} incrementalMedianMs=${incremental.medianPostEditMs.toFixed(2)} speedup=${speedup.toFixed(2)}x baselinePeakRssDeltaMb=${baseline.peakRssDeltaMb.toFixed(2)} incrementalPeakRssDeltaMb=${incremental.peakRssDeltaMb.toFixed(2)} rssReduction=${rssReductionPct.toFixed(2)}%`,
          );

          expect(
            speedup,
            `${scenario.name} speedup expected >= ${minSpeedup}x`,
          ).toBeGreaterThanOrEqual(minSpeedup);
          expect(
            rssReductionPct,
            `${scenario.name} RSS reduction expected >= ${minRssReductionPct}%`,
          ).toBeGreaterThanOrEqual(minRssReductionPct);
        } finally {
          await rm(project.rootDir, { recursive: true, force: true });
        }
      }
    },
    Number.parseInt(process.env.VOYD_LS_PERF_TIMEOUT_MS ?? "1800000", 10),
  );
});
