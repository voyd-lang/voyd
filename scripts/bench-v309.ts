import path from "node:path";
import { performance } from "node:perf_hooks";
import { gzipSync } from "node:zlib";
import { createSdk, type CompileResult } from "@voyd-lang/sdk";
import { createVoydHost } from "@voyd-lang/sdk/js-host";

type Scenario = {
  name: string;
  entryName: string;
  iterations: number;
  warmups: number;
  expected: number;
  source?: string;
  entryPath?: string;
};

type ScenarioResult = {
  name: string;
  wasmBytes: number;
  gzipBytes: number;
  medianMs: number;
  samplesMs: number[];
};

const focusedSource = `
obj Vec3 {
  x: i32,
  y: i32,
  z: i32
}

fn sum_vec(vec: Vec3) -> i32
  vec.x + vec.y + vec.z

pub fn runtime_type_check_elision() -> i32
  var i = 0
  var total = 0
  while i < 20000:
    total = total + sum_vec(Vec3 { x: i, y: i + 1, z: i + 2 })
    i = i + 1
  total

pub fn semantic_copy_forwarding() -> i32
  var i = 0
  var total = 0
  while i < 20000:
    total = total + (Vec3 { x: i, y: i + 1, z: i + 2 }).y
    i = i + 1
  total
`;

const defaultIterations = Number.parseInt(process.env.VOYD_BENCH_ITERATIONS ?? "9", 10);
const vtraceIterations = Number.parseInt(process.env.VOYD_BENCH_VTRACE_ITERATIONS ?? "3", 10);

const scenarios: Scenario[] = [
  {
    name: "focused/runtime-type-check-elision",
    source: focusedSource,
    entryName: "runtime_type_check_elision",
    iterations: defaultIterations,
    warmups: 2,
    expected: 600_030_000,
  },
  {
    name: "focused/semantic-copy-forwarding",
    source: focusedSource,
    entryName: "semantic_copy_forwarding",
    iterations: defaultIterations,
    warmups: 2,
    expected: 200_010_000,
  },
  {
    name: "realistic/vtrace-main",
    entryPath: path.join(
      import.meta.dirname,
      "..",
      "apps",
      "smoke",
      "fixtures",
      "vtrace-compute-benchmark.voyd"
    ),
    entryName: "main",
    iterations: vtraceIterations,
    warmups: 1,
    expected: 3_825_271,
  },
];

const expectCompileSuccess = (
  result: CompileResult,
  name: string
): Extract<CompileResult, { success: true }> => {
  if (result.success) {
    return result;
  }

  throw new Error(
    `${name} failed to compile:\n${result.diagnostics
      .map((diagnostic) => diagnostic.message)
      .join("\n")}`
  );
};

const median = (values: number[]): number => {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
};

const runScenario = async (scenario: Scenario): Promise<ScenarioResult> => {
  const sdk = createSdk();
  const compiled = expectCompileSuccess(
    await sdk.compile({
      entryPath: scenario.entryPath,
      source: scenario.source,
      optimize: true,
    }),
    scenario.name
  );
  const host = await createVoydHost({ wasm: compiled.wasm });

  for (let warmup = 0; warmup < scenario.warmups; warmup += 1) {
    const result = await host.run<number>(scenario.entryName);
    if (result !== scenario.expected) {
      throw new Error(
        `${scenario.name} returned ${result} during warmup, expected ${scenario.expected}`
      );
    }
  }

  const samplesMs: number[] = [];
  for (let iteration = 0; iteration < scenario.iterations; iteration += 1) {
    const startedAt = performance.now();
    const result = await host.run<number>(scenario.entryName);
    const durationMs = performance.now() - startedAt;
    if (result !== scenario.expected) {
      throw new Error(
        `${scenario.name} returned ${result}, expected ${scenario.expected}`
      );
    }
    samplesMs.push(durationMs);
  }

  return {
    name: scenario.name,
    wasmBytes: compiled.wasm.byteLength,
    gzipBytes: gzipSync(compiled.wasm).byteLength,
    medianMs: median(samplesMs),
    samplesMs,
  };
};

const printResults = (results: readonly ScenarioResult[]): void => {
  console.log("name,wasmBytes,gzipBytes,medianMs,samplesMs");
  for (const result of results) {
    console.log(
      [
        result.name,
        result.wasmBytes.toString(),
        result.gzipBytes.toString(),
        result.medianMs.toFixed(3),
        result.samplesMs.map((sample) => sample.toFixed(3)).join("|"),
      ].join(",")
    );
  }
};

const main = async (): Promise<void> => {
  const results: ScenarioResult[] = [];
  for (const scenario of scenarios) {
    results.push(await runScenario(scenario));
  }
  printResults(results);
};

await main();
