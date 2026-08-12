import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpus, totalmem } from "node:os";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import type { CompileResult } from "@voyd-lang/sdk";
import {
  captureCompilerPerf,
  createProcessMemoryTracker,
  emitBenchmarkReport,
} from "./benchmark-report.js";

type Entrypoint = {
  name: string;
  expected: unknown;
  args?: readonly unknown[];
};

type Scenario = {
  name: string;
  entryPath: string;
  entrypoints: readonly Entrypoint[];
  requiredPositiveCounters?: readonly string[];
  wasmSignals?: readonly {
    name: string;
    pattern: RegExp;
    expected: "present" | "absent";
  }[];
};

type CompileSuccess = Extract<CompileResult, { success: true }>;

const valueAfter = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const sampleCount = Number.parseInt(valueAfter("--samples") ?? "7", 10);
const runtimeSampleCount = Number.parseInt(
  valueAfter("--runtime-samples") ?? "31",
  10,
);
const label = valueAfter("--label") ?? "worktree";
const scenarioFilter = valueAfter("--scenario");
const sdkRoot = valueAfter("--sdk-root");
const outputPath = valueAfter("--output");
if (sampleCount < 3 || runtimeSampleCount < 3) {
  throw new Error(
    "benchmark requires at least three compile and runtime samples",
  );
}

const repository = path.resolve(import.meta.dirname, "..");
process.env.VOYD_COMPILER_PERF = "1";
const sdkModule = sdkRoot
  ? pathToFileURL(path.join(sdkRoot, "packages", "sdk", "src", "index.ts")).href
  : "@voyd-lang/sdk";
const sdkHostModule = sdkRoot
  ? pathToFileURL(path.join(sdkRoot, "packages", "sdk", "src", "js-host.ts"))
      .href
  : "@voyd-lang/sdk/js-host";
const { createSdk } = (await import(
  sdkModule
)) as typeof import("@voyd-lang/sdk");
const { createVoydHost } = (await import(
  sdkHostModule
)) as typeof import("@voyd-lang/sdk/js-host");
const performanceFixtures = path.join(
  repository,
  "tests",
  "performance",
  "fixtures",
);
const scenarios: readonly Scenario[] = [
  {
    name: "representative-vtrace",
    entryPath: path.join(performanceFixtures, "vtrace-compute-benchmark.voyd"),
    entrypoints: [{ name: "main", expected: 428_553 }],
  },
  {
    name: "focused-checked-access",
    entryPath: path.join(performanceFixtures, "checked-access-optimizer.voyd"),
    entrypoints: [
      { name: "checked_access_memory_traffic", expected: 2_200_000 },
      { name: "memory_traffic_control", expected: 2_200_000 },
      { name: "hoisted_memory_traffic_control", expected: 2_200_000 },
      { name: "ordinary_mutation_control", expected: 100_003 },
      { name: "shared_cell_runtime_checks", expected: 100_003 },
      { name: "checked_array_loop", expected: 3_400_000 },
      { name: "optional_array_loop", expected: 3_400_000 },
    ],
  },
  {
    name: "representative-scalar-aggregate",
    entryPath: path.join(
      performanceFixtures,
      "scalar-aggregate-representative.voyd",
    ),
    entrypoints: [{ name: "main", expected: 1_100_340_000 }],
  },
  {
    name: "representative-web-app-request",
    entryPath: path.join(performanceFixtures, "web-app-request-pipeline.voyd"),
    entrypoints: [
      { name: "main", expected: 708_207_620 },
      { name: "request_lookup_stage", expected: 302_557_517 },
      { name: "response_serialization_stage", expected: 600_952_779 },
    ],
  },
  {
    name: "isolated-range-optimizations",
    entryPath: path.join(
      performanceFixtures,
      "v500-range-optimizations.voyd",
    ),
    entrypoints: [
      { name: "direct_range_workload", expected: 4_960_000 },
      {
        name: "range_array_checked_access_workload",
        expected: 7_600_000,
      },
    ],
    requiredPositiveCounters: [
      "codegen.intrinsic_range_for.accepted",
      "codegen.range_array_safe_scope.accepted",
    ],
    wasmSignals: [
      {
        name: "direct-array-access",
        pattern: /\(array\.get(?:_[su])?\b/,
        expected: "present",
      },
      {
        name: "general-range-iterator",
        pattern: /\$std__range__RangeIterator/,
        expected: "absent",
      },
    ],
  },
  {
    name: "deferred-default-identity-guard",
    entryPath: path.join(
      performanceFixtures,
      "v500-deferred-default-guard.voyd",
    ),
    entrypoints: [
      { name: "deferred_guard_dynamic", args: [1], expected: 15 },
    ],
    requiredPositiveCounters: [
      "borrowing.identity_guard.emitted.deferred_default",
      "codegen.default_identity_guard_companion.requested",
      "codegen.default_identity_guard_companion.created",
      "codegen.default_identity_guard_companion.compiled",
    ],
    wasmSignals: [
      {
        name: "deferred-identity-comparison",
        pattern: /\(ref\.eq\b/,
        expected: "present",
      },
      {
        name: "deferred-panic-path",
        pattern: /__voyd_panic_ptr/,
        expected: "present",
      },
    ],
  },
];

if (!scenarioFilter) {
  const script = fileURLToPath(import.meta.url);
  const documents = scenarios.map(
    (scenario) =>
      JSON.parse(
        execFileSync(
          process.execPath,
          [
            "--import",
            "tsx",
            "--conditions=development",
            script,
            "--label",
            label,
            "--samples",
            sampleCount.toString(),
            "--runtime-samples",
            runtimeSampleCount.toString(),
            "--scenario",
            scenario.name,
            ...(sdkRoot ? ["--sdk-root", sdkRoot] : []),
          ],
          {
            cwd: repository,
            encoding: "utf8",
            maxBuffer: 100 * 1024 * 1024,
            stdio: ["ignore", "pipe", "inherit"],
          },
        ),
      ) as {
        schemaVersion: number;
        label: string;
        methodology: unknown;
        environment: unknown;
        results: unknown[];
      },
  );
  const first = documents[0];
  if (!first) {
    throw new Error("benchmark has no scenarios");
  }
  emitBenchmarkReport({
    report: {
      schemaVersion: first.schemaVersion,
      label: first.label,
      methodology: first.methodology,
      environment: first.environment,
      results: documents.flatMap((document) => document.results),
    },
    outputPath,
  });
  process.exit(0);
}

const selectedScenarios = scenarioFilter
  ? scenarios.filter((scenario) => scenario.name === scenarioFilter)
  : scenarios;
if (selectedScenarios.length === 0) {
  throw new Error(`unknown benchmark scenario ${scenarioFilter}`);
}

const median = (values: readonly number[]): number => {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? (ordered[middle - 1]! + ordered[middle]!) / 2
    : ordered[middle]!;
};

const expectCompileSuccess = (
  result: CompileResult,
  scenario: string,
): CompileSuccess => {
  if (result.success) {
    return result;
  }
  throw new Error(
    `${scenario} failed to compile:\n${("diagnostics" in result ? result.diagnostics : [])
      .map((diagnostic) => diagnostic.message)
      .join("\n")}`,
  );
};

const assertResult = ({
  scenario,
  entrypoint,
  actual,
}: {
  scenario: string;
  entrypoint: Entrypoint;
  actual: unknown;
}): void => {
  if (Object.is(actual, entrypoint.expected)) {
    return;
  }
  throw new Error(
    `${scenario}.${entrypoint.name} returned ${String(actual)}, expected ${String(
      entrypoint.expected,
    )}`,
  );
};

const count = (source: string, pattern: RegExp): number =>
  Array.from(source.matchAll(pattern)).length;

const medianRecord = (
  records: readonly Readonly<Record<string, number>>[],
): Record<string, number> => {
  const keys = new Set(records.flatMap((record) => Object.keys(record)));
  return Object.fromEntries(
    Array.from(keys)
      .sort()
      .map((key) => [key, median(records.map((record) => record[key] ?? 0))]),
  );
};

const codeShape = (wasmText: string) => ({
  allocationSites: count(
    wasmText,
    /\((?:array|struct)\.new(?:_fixed|_default)?\b/g,
  ),
  structGets: count(wasmText, /\(struct\.get\b/g),
  structSets: count(wasmText, /\(struct\.set\b/g),
  arrayGets: count(wasmText, /\(array\.get(?:_[su])?\b/g),
  arraySets: count(wasmText, /\(array\.set\b/g),
  arrayLengths: count(wasmText, /\(array\.len\b/g),
  identityComparisons: count(wasmText, /\(ref\.eq\b/g),
  directCalls: count(wasmText, /\(call\s+\$/g),
  indirectCalls: count(wasmText, /\(call_ref\b/g),
  unreachableSites: count(wasmText, /\(unreachable\b/g),
  rangeIteratorReferences: count(wasmText, /\$std__range__RangeIterator/g),
  defaultIdentityGuardCompanionReferences: count(
    wasmText,
    /__default_identity_guard_v1/g,
  ),
});

const escapeRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const watForExport = (wasmText: string, exportName: string): string => {
  const exportedFunction = wasmText.match(
    new RegExp(
      `\\(export "${escapeRegex(exportName)}" \\(func \\$([^\\s\\)]+)\\)\\)`,
    ),
  )?.[1];
  if (!exportedFunction) return "";
  const start = wasmText.indexOf(`(func $${exportedFunction} `);
  if (start < 0) return "";
  let depth = 0;
  for (let index = start; index < wasmText.length; index += 1) {
    if (wasmText[index] === "(") depth += 1;
    if (wasmText[index] === ")") depth -= 1;
    if (depth === 0) return wasmText.slice(start, index + 1);
  }
  return "";
};

const measureScenario = async ({
  scenario,
  optimize,
}: {
  scenario: Scenario;
  optimize: boolean;
}) => {
  const memoryTracker = createProcessMemoryTracker();
  const compileMs: number[] = [];
  const compileRssBytes: number[] = [];
  const compilerPerfSamples: Array<{
    phasesMs: Record<string, number>;
    counters: Record<string, number>;
  }> = [];
  let compiled: CompileSuccess | undefined;
  for (let sample = 0; sample < sampleCount; sample += 1) {
    const startedAt = performance.now();
    const captured = await captureCompilerPerf(() =>
      createSdk().compile({
        entryPath: scenario.entryPath,
        optimize,
        emitWasmText: true,
      }),
    );
    compiled = expectCompileSuccess(captured.value, scenario.name);
    compileMs.push(performance.now() - startedAt);
    memoryTracker.sample();
    compileRssBytes.push(process.memoryUsage().rss);
    const summary = captured.summaries.at(-1);
    compilerPerfSamples.push({
      phasesMs: summary?.phasesMs ?? {},
      counters: summary?.counters ?? {},
    });
  }
  if (!compiled) {
    throw new Error(`${scenario.name} did not produce a compiled module`);
  }

  let maxLinearMemoryGrowthBytes = 0;
  const runtimeEntries: Array<
    readonly [string, { samplesMs: number[]; medianMs: number }]
  > = [];
  for (const entrypoint of scenario.entrypoints) {
    const host = await createVoydHost({ wasm: compiled.wasm });
    for (let warmup = 0; warmup < 3; warmup += 1) {
      assertResult({
        scenario: scenario.name,
        entrypoint,
        actual: await host.run<unknown>(entrypoint.name, [
          ...(entrypoint.args ?? []),
        ]),
      });
    }
    const memory = host.instance.exports.memory;
    const beforeBytes =
      memory instanceof WebAssembly.Memory ? memory.buffer.byteLength : 0;
    const samplesMs: number[] = [];
    for (let sample = 0; sample < runtimeSampleCount; sample += 1) {
      const startedAt = performance.now();
      const actual = await host.run<unknown>(entrypoint.name, [
        ...(entrypoint.args ?? []),
      ]);
      samplesMs.push(performance.now() - startedAt);
      assertResult({ scenario: scenario.name, entrypoint, actual });
    }
    runtimeEntries.push([
      entrypoint.name,
      { samplesMs, medianMs: median(samplesMs) },
    ]);
    const afterBytes =
      memory instanceof WebAssembly.Memory ? memory.buffer.byteLength : 0;
    maxLinearMemoryGrowthBytes = Math.max(
      maxLinearMemoryGrowthBytes,
      afterBytes - beforeBytes,
    );
  }
  const runtime = Object.fromEntries(runtimeEntries);
  const wasmText = compiled.wasmText ?? "";
  const phaseMediansMs = medianRecord(
    compilerPerfSamples.map((sample) => sample.phasesMs),
  );
  const counterMedians = medianRecord(
    compilerPerfSamples.map((sample) => sample.counters),
  );
  const processMemory = memoryTracker.finish();

  return {
    optimize,
    compile: {
      samplesMs: compileMs,
      medianMs: median(compileMs),
      rssSamplesBytes: compileRssBytes,
      rssMedianBytes: median(compileRssBytes),
      perfSamples: compilerPerfSamples,
      phaseMediansMs,
      counterMedians,
    },
    runtime,
    processMemory,
    linearMemoryGrowthBytes: maxLinearMemoryGrowthBytes,
    wasmBytes: compiled.wasm.byteLength,
    gzipBytes: gzipSync(compiled.wasm).byteLength,
    wasmTextBytes: new TextEncoder().encode(wasmText).byteLength,
    wasmSha256: createHash("sha256").update(compiled.wasm).digest("hex"),
    codeShape: codeShape(wasmText),
    entrypointCodeShape: Object.fromEntries(
      scenario.entrypoints.map((entrypoint) => [
        entrypoint.name,
        codeShape(watForExport(wasmText, entrypoint.name)),
      ]),
    ),
    expectedSignals: {
      positiveCounters: Object.fromEntries(
        (scenario.requiredPositiveCounters ?? []).map((counter) => [
          counter,
          {
            value: counterMedians[counter] ?? 0,
            observed: (counterMedians[counter] ?? 0) > 0,
          },
        ]),
      ),
      wasm: Object.fromEntries(
        (scenario.wasmSignals ?? []).map((signal) => {
          const matched = signal.pattern.test(wasmText);
          return [
            signal.name,
            {
              expected: signal.expected,
              observed: signal.expected === "present" ? matched : !matched,
            },
          ];
        }),
      ),
    },
  };
};

const results = [];
for (const scenario of selectedScenarios) {
  const none = await measureScenario({ scenario, optimize: false });
  const release = await measureScenario({ scenario, optimize: true });
  results.push({ scenario: scenario.name, modes: { none, release } });
}

const cpu = cpus();
emitBenchmarkReport({
  report: {
    schemaVersion: 2,
    label,
    methodology: {
      compileSamples: sampleCount,
      freshSdkPerCompile: true,
      runtimeWarmups: 3,
      runtimeSamples: runtimeSampleCount,
      freshHostPerEntrypoint: true,
      modes: ["none", "release"],
      sdkRoot: sdkRoot ? path.resolve(sdkRoot) : repository,
      compilerPerf: "VOYD_COMPILER_PERF=1; raw summary retained per compile",
      processMemory:
        "post-compile RSS samples plus sampled and operating-system peak RSS",
      codeShape:
        "Static instruction-site counts from emitted WAT for complete modules and each benchmark export",
    },
    environment: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      cpu: cpu[0]?.model ?? "unknown",
      logicalCpus: cpu.length,
      totalMemoryBytes: totalmem(),
    },
    results,
  },
  outputPath,
});
