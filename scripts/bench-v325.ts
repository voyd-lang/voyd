import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { gzipSync } from "node:zlib";
import { createSdk, type CompileResult } from "@voyd-lang/sdk";
import { createVoydHost } from "@voyd-lang/sdk/js-host";

type Scenario = {
  name: string;
  iterations: number;
  warmups: number;
  source?: string;
  entryPath?: string;
  entryName?: string;
  expected?: number;
};

type ScenarioResult = {
  name: string;
  optimize: boolean;
  compileMs: number;
  wasmBytes: number;
  gzipBytes: number;
  wasmSha256: string;
  medianMs?: number;
  samplesMs: number[];
};

const focusedSource = `
obj Pair {
  x: i32,
  y: i32
}

trait Scored
  fn score(self) -> i32

impl Scored for Pair
  fn score(self) -> i32
    self.x + self.y

fn pair_sum(pair: Pair) -> i32
  pair.x + pair.y

fn identity(pair: Pair) -> Pair
  pair

pub fn non_escaping_aggregate() -> i32
  var i = 0
  var total = 0
  while i < 20000:
    let pair = Pair { x: i, y: i + 1 }
    total = total + pair_sum(pair)
    i = i + 1
  total

pub fn mutable_temporary_record() -> i32
  var i = 0
  var total = 0
  while i < 20000:
    let ~pair = Pair { x: i, y: i + 1 }
    pair.x = pair.x + 1
    total = total + pair.x + pair.y
    i = i + 1
  total

pub fn trait_typed_temporary() -> i32
  var i = 0
  var total = 0
  while i < 20000:
    total = total + score_trait(Pair { x: i, y: i + 1 })
    i = i + 1
  total

fn score_trait(value: Scored) -> i32
  value.score()

pub fn call_boundary_escape() -> i32
  var i = 0
  var total = 0
  while i < 20000:
    total = total + identity(Pair { x: i, y: i + 1 }).x
    i = i + 1
  total
`;

const defaultIterations = Number.parseInt(
  process.env.VOYD_BENCH_ITERATIONS ?? "5",
  10,
);
const representativeIterations = Number.parseInt(
  process.env.VOYD_BENCH_REPRESENTATIVE_ITERATIONS ?? "1",
  10,
);
const optimizeModes = (process.env.VOYD_BENCH_OPTIMIZE_MODES ?? "false,true")
  .split(",")
  .map((value) => value.trim().toLowerCase())
  .filter((value) => value.length > 0)
  .map((value) => {
    if (value === "true" || value === "1") {
      return true;
    }
    if (value === "false" || value === "0") {
      return false;
    }
    throw new Error(`invalid VOYD_BENCH_OPTIMIZE_MODES entry ${value}`);
  });

const maybeFileScenario = (scenario: Scenario): Scenario[] =>
  scenario.entryPath && !fs.existsSync(scenario.entryPath) ? [] : [scenario];

const scenarios: Scenario[] = [
  {
    name: "focused/non-escaping-aggregate",
    source: focusedSource,
    entryName: "non_escaping_aggregate",
    expected: 400_000_000,
    iterations: defaultIterations,
    warmups: 2,
  },
  {
    name: "focused/mutable-temporary-record",
    source: focusedSource,
    entryName: "mutable_temporary_record",
    expected: 400_020_000,
    iterations: defaultIterations,
    warmups: 2,
  },
  {
    name: "focused/trait-typed-temporary",
    source: focusedSource,
    entryName: "trait_typed_temporary",
    expected: 400_000_000,
    iterations: defaultIterations,
    warmups: 2,
  },
  {
    name: "focused/call-boundary-escape",
    source: focusedSource,
    entryName: "call_boundary_escape",
    expected: 199_990_000,
    iterations: defaultIterations,
    warmups: 2,
  },
  {
    name: "representative/vtrace-compute-main",
    entryPath: path.join(
      import.meta.dirname,
      "..",
      "tests",
      "performance",
      "fixtures",
      "vtrace-compute-benchmark.voyd",
    ),
    entryName: "main",
    expected: 3_825_271,
    iterations: representativeIterations,
    warmups: 1,
  },
  ...maybeFileScenario({
    name: "voyd-examples/vtrace-fast-compile",
    entryPath: "/Users/drew/projects/voyd_examples/src/vtrace_fast.voyd",
    iterations: 0,
    warmups: 0,
  }),
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
      .map((diagnostic) => diagnostic.message)
      .join("\n")}`,
  );
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

const runScenario = async ({
  scenario,
  optimize,
}: {
  scenario: Scenario;
  optimize: boolean;
}): Promise<ScenarioResult> => {
  const sdk = createSdk();
  const compileStartedAt = performance.now();
  const compiled = expectCompileSuccess(
    await sdk.compile({
      entryPath: scenario.entryPath,
      source: scenario.source,
      optimize,
    }),
    scenario.name,
  );
  const compileMs = performance.now() - compileStartedAt;

  const samplesMs: number[] = [];
  if (scenario.entryName && typeof scenario.expected === "number") {
    const host = await createVoydHost({ wasm: compiled.wasm });
    for (let warmup = 0; warmup < scenario.warmups; warmup += 1) {
      const result = await host.run<number>(scenario.entryName);
      if (result !== scenario.expected) {
        throw new Error(
          `${scenario.name} returned ${result} during warmup, expected ${scenario.expected}`,
        );
      }
    }
    for (let iteration = 0; iteration < scenario.iterations; iteration += 1) {
      const startedAt = performance.now();
      const result = await host.run<number>(scenario.entryName);
      if (result !== scenario.expected) {
        throw new Error(
          `${scenario.name} returned ${result}, expected ${scenario.expected}`,
        );
      }
      samplesMs.push(performance.now() - startedAt);
    }
  }

  return {
    name: scenario.name,
    optimize,
    compileMs,
    wasmBytes: compiled.wasm.byteLength,
    gzipBytes: gzipSync(compiled.wasm).byteLength,
    wasmSha256: createHash("sha256").update(compiled.wasm).digest("hex"),
    medianMs: median(samplesMs),
    samplesMs,
  };
};

const printResults = (results: readonly ScenarioResult[]): void => {
  console.log(
    "name,optimize,compileMs,wasmBytes,gzipBytes,wasmSha256,medianMs,samplesMs",
  );
  results.forEach((result) => {
    console.log(
      [
        result.name,
        result.optimize ? "true" : "false",
        result.compileMs.toFixed(3),
        result.wasmBytes.toString(),
        result.gzipBytes.toString(),
        result.wasmSha256,
        result.medianMs === undefined ? "" : result.medianMs.toFixed(3),
        result.samplesMs.map((sample) => sample.toFixed(3)).join("|"),
      ].join(","),
    );
  });
};

const main = async (): Promise<void> => {
  const results: ScenarioResult[] = [];
  for (const scenario of scenarios) {
    for (const optimize of optimizeModes) {
      results.push(await runScenario({ scenario, optimize }));
    }
  }
  printResults(results);
};

await main();
