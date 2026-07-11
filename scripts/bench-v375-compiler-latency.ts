import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { gzipSync } from "node:zlib";
import { createSdk, type CompileResult } from "@voyd-lang/sdk";
import { createVoydHost } from "@voyd-lang/sdk/js-host";

type Scenario = {
  name: string;
  allowMissing?: boolean;
  allowFailure?: boolean;
  entryPath: string;
  entryName?: string;
  expected?: number;
  runtimeSamples?: number;
};

type CompileRow = {
  name: string;
  optimize: boolean;
  sdkReuse: boolean;
  compileKind: "cold" | "warm-app-edit";
  compileIndex: number;
  compileMs: number;
  wasmBytes: number;
  gzipBytes: number;
  heapUsedBytes: number;
  wasmSha256: string;
  runtimeMedianMs?: number;
  runtimeSamplesMs: readonly number[];
};

const repeatCount = Number.parseInt(
  process.env.VOYD_COMPILER_LATENCY_REPEATS ?? "3",
  10,
);
const freshSdkPerCompile = ["1", "true", "yes"].includes(
  (process.env.VOYD_COMPILER_LATENCY_FRESH_SDK ?? "").trim().toLowerCase(),
);
const optimizeModes = (process.env.VOYD_BENCH_OPTIMIZE_MODES ?? "true")
  .split(",")
  .map((value) => value.trim().toLowerCase())
  .filter((value) => value.length > 0)
  .map((value) => {
    if (value === "true" || value === "1") return true;
    if (value === "false" || value === "0") return false;
    throw new Error(`invalid VOYD_BENCH_OPTIMIZE_MODES entry ${value}`);
  });
const scenarioFilter = new Set(
  (process.env.VOYD_COMPILER_LATENCY_SCENARIOS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0),
);

const scenarios: Scenario[] = [
  {
    name: "smoke/std-math-transcendentals",
    entryPath: path.resolve(
      "tests/integration/fixtures/std-math-transcendentals.voyd",
    ),
    entryName: "main",
    expected: 1,
    runtimeSamples: 3,
  },
  {
    name: "smoke/scalar-aggregate-representative",
    entryPath: path.resolve(
      "tests/performance/fixtures/scalar-aggregate-representative.voyd",
    ),
    entryName: "main",
    expected: 1_100_340_000,
    runtimeSamples: 3,
  },
  {
    name: "smoke/vtrace-compute-main",
    entryPath: path.resolve(
      "tests/performance/fixtures/vtrace-compute-benchmark.voyd",
    ),
    entryName: "main",
    expected: 3_825_271,
    runtimeSamples: 1,
  },
  {
    name: "smoke/vtrace-compute-benchmark",
    entryPath: path.resolve(
      "tests/performance/fixtures/vtrace-compute-benchmark.voyd",
    ),
    entryName: "benchmark",
    expected: 57_372_071,
    runtimeSamples: Number.parseInt(
      process.env.VOYD_COMPILER_LATENCY_VTRACE_RUNTIME_SAMPLES ?? "1",
      10,
    ),
  },
  {
    name: "voyd_examples/ray-vtrace-tuned",
    entryPath:
      "/Users/drew/projects/voyd_examples/benchmarks/ray/voyd/vtrace_tuned.voyd",
    allowMissing: true,
  },
  {
    name: "voyd_examples/suite-compile",
    entryPath:
      "/Users/drew/projects/voyd_examples/benchmarks/suite/voyd/benchmarks.voyd",
    allowMissing: true,
    allowFailure: true,
  },
];

const expectCompileSuccess = (
  result: CompileResult,
  name: string,
): Extract<CompileResult, { success: true }> => {
  if (result.success) {
    return result;
  }

  throw new Error(
    `${name} failed to compile:\n${result.diagnostics
      .map((diagnostic) => formatDiagnosticMessage(diagnostic.message))
      .join("\n")}`,
  );
};

const formatDiagnosticMessage = (message: unknown): string => {
  if (typeof message === "string") {
    return message;
  }
  return JSON.stringify(message);
};

const median = (values: readonly number[]): number | undefined => {
  if (values.length === 0) {
    return undefined;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle];
};

const runRuntimeSamples = async ({
  wasm,
  scenario,
}: {
  wasm: Uint8Array;
  scenario: Scenario;
}): Promise<number[]> => {
  if (!scenario.entryName || scenario.expected === undefined) {
    return [];
  }

  const host = await createVoydHost({ wasm });
  const samples: number[] = [];
  const sampleCount = scenario.runtimeSamples ?? 1;
  for (let index = 0; index < sampleCount; index += 1) {
    const startedAt = performance.now();
    const result = await host.run<number>(scenario.entryName);
    const elapsed = performance.now() - startedAt;
    if (result !== scenario.expected) {
      throw new Error(
        `${scenario.name} returned ${result}, expected ${scenario.expected}`,
      );
    }
    samples.push(elapsed);
  }
  return samples;
};

const runScenario = async ({
  scenario,
  optimize,
}: {
  scenario: Scenario;
  optimize: boolean;
}): Promise<CompileRow[]> => {
  const sharedSdk = freshSdkPerCompile ? undefined : createSdk();
  const rows: CompileRow[] = [];
  const repeats = Math.max(1, repeatCount);
  const baseSource = fs.readFileSync(scenario.entryPath, "utf8");

  for (let compileIndex = 0; compileIndex < repeats; compileIndex += 1) {
    (globalThis as { gc?: () => void }).gc?.();
    const sdk = sharedSdk ?? createSdk();
    const startedAt = performance.now();
    const compiled = expectCompileSuccess(
      await sdk.compile({
        entryPath: scenario.entryPath,
        source:
          compileIndex === 0
            ? baseSource
            : sourceWithAppEdit({ source: baseSource, compileIndex }),
        optimize,
      }),
      scenario.name,
    );
    const compileMs = performance.now() - startedAt;
    const heapUsedBytes = process.memoryUsage().heapUsed;
    const runtimeSamplesMs =
      compileIndex === 0
        ? await runRuntimeSamples({ wasm: compiled.wasm, scenario })
        : [];

    rows.push({
      name: scenario.name,
      optimize,
      sdkReuse: !freshSdkPerCompile,
      compileKind: compileIndex === 0 ? "cold" : "warm-app-edit",
      compileIndex,
      compileMs,
      wasmBytes: compiled.wasm.byteLength,
      gzipBytes: gzipSync(compiled.wasm).byteLength,
      heapUsedBytes,
      wasmSha256: createHash("sha256").update(compiled.wasm).digest("hex"),
      runtimeMedianMs: median(runtimeSamplesMs),
      runtimeSamplesMs,
    });
  }

  return rows;
};

const sourceWithAppEdit = ({
  source,
  compileIndex,
}: {
  source: string;
  compileIndex: number;
}): string =>
  `${source}\nfn v375_app_edit_marker_${compileIndex}() -> i32\n  ${compileIndex}\n`;

const printRows = (rows: readonly CompileRow[]): void => {
  console.log(
    [
      "name",
      "optimize",
      "sdkReuse",
      "compileKind",
      "compileIndex",
      "compileMs",
      "wasmBytes",
      "gzipBytes",
      "heapUsedBytes",
      "wasmSha256",
      "runtimeMedianMs",
      "runtimeSamplesMs",
    ].join(","),
  );
  rows.forEach((row) => {
    console.log(
      [
        row.name,
        row.optimize ? "true" : "false",
        row.sdkReuse ? "true" : "false",
        row.compileKind,
        row.compileIndex.toString(),
        row.compileMs.toFixed(3),
        row.wasmBytes.toString(),
        row.gzipBytes.toString(),
        row.heapUsedBytes.toString(),
        row.wasmSha256,
        row.runtimeMedianMs === undefined ? "" : row.runtimeMedianMs.toFixed(3),
        row.runtimeSamplesMs.map((sample) => sample.toFixed(3)).join("|"),
      ].join(","),
    );
  });
};

const main = async (): Promise<void> => {
  const rows: CompileRow[] = [];
  for (const scenario of scenarios.filter(
    ({ name }) => scenarioFilter.size === 0 || scenarioFilter.has(name),
  )) {
    if (!fs.existsSync(scenario.entryPath)) {
      if (scenario.allowMissing) {
        continue;
      }
      throw new Error(`missing benchmark scenario ${scenario.entryPath}`);
    }
    for (const optimize of optimizeModes) {
      try {
        rows.push(...(await runScenario({ scenario, optimize })));
      } catch (error) {
        if (!scenario.allowFailure) {
          throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        console.error(
          `[bench-v375] skipping optional ${scenario.name}: ${message}`,
        );
      }
    }
  }
  printRows(rows);
};

void main();
