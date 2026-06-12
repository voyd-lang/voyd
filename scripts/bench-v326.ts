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
  optional?: boolean;
  source?: string;
  entryPath?: string;
  entryName?: string;
  expected?: number;
};

type ScenarioResult = {
  revision: string;
  name: string;
  optimize: boolean;
  compileMs: number;
  wasmBytes: number;
  gzipBytes: number;
  wasmSha256: string;
  wasmTextBytes: number;
  structNewCount: number;
  structNewDefaultCount: number;
  tupleMakeCount: number;
  medianMs?: number;
  samplesMs: number[];
};

const focusedSource = `
obj Pair {
  x: i32,
  y: i32
}

val Vec3 {
  x: i32,
  y: i32,
  z: i32
}

fn sum_vec(vec: Vec3) -> i32
  vec.x + vec.y + vec.z

fn identity(pair: Pair) -> Pair
  pair

fn sum_pair(pair: Pair) -> i32
  pair.x + pair.y

fn make_pair(seed: i32) -> Pair
  Pair { x: seed, y: seed + 1 }

pub fn non_escaping_object_local() -> i32
  var i = 0
  var total = 0
  while i < 20000:
    let pair = Pair { x: i, y: i + 1 }
    total = total + pair.x + pair.y
    i = i + 1
  total

pub fn mutable_object_temporary() -> i32
  var i = 0
  var total = 0
  while i < 20000:
    let ~pair = Pair { x: i, y: i + 1 }
    pair.x = pair.x + 1
    total = total + pair.x + pair.y
    i = i + 1
  total

pub fn direct_value_call_argument() -> i32
  var i = 0
  var total = 0
  while i < 20000:
    total = total + sum_vec(Vec3 { x: i, y: i + 1, z: i + 2 })
    i = i + 1
  total

pub fn direct_heap_call_argument() -> i32
  var i = 0
  var total = 0
  while i < 20000:
    let pair = Pair { x: i, y: i + 1 }
    total = total + sum_pair(pair)
    i = i + 1
  total

pub fn direct_heap_call_literal() -> i32
  var i = 0
  var total = 0
  while i < 20000:
    total = total + sum_pair(Pair { x: i, y: i + 1 })
    i = i + 1
  total

pub fn direct_heap_call_return() -> i32
  var i = 0
  var total = 0
  while i < 20000:
    let pair = make_pair(i)
    total = total + pair.x + pair.y
    i = i + 1
  total

pub fn escape_boundary_rematerialization() -> i32
  var i = 0
  var total = 0
  while i < 20000:
    total = total + identity(Pair { x: i, y: i + 1 }).x
    i = i + 1
  total
`;

const defaultIterations = Number.parseInt(process.env.VOYD_BENCH_ITERATIONS ?? "7", 10);
const representativeIterations = Number.parseInt(
  process.env.VOYD_BENCH_REPRESENTATIVE_ITERATIONS ?? "3",
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
const revisionLabel = process.env.VOYD_BENCH_REVISION ?? "worktree";

const maybeFileScenario = (scenario: Scenario): Scenario[] =>
  scenario.entryPath && !fs.existsSync(scenario.entryPath) ? [] : [scenario];

const scenarios: Scenario[] = [
  {
    name: "focused/non-escaping-object-local",
    source: focusedSource,
    entryName: "non_escaping_object_local",
    expected: 400_000_000,
    iterations: defaultIterations,
    warmups: 2,
  },
  {
    name: "focused/mutable-object-temporary",
    source: focusedSource,
    entryName: "mutable_object_temporary",
    expected: 400_020_000,
    iterations: defaultIterations,
    warmups: 2,
  },
  {
    name: "focused/direct-value-call-argument",
    source: focusedSource,
    entryName: "direct_value_call_argument",
    expected: 600_030_000,
    iterations: defaultIterations,
    warmups: 2,
  },
  {
    name: "focused/direct-heap-call-argument",
    source: focusedSource,
    entryName: "direct_heap_call_argument",
    expected: 400_000_000,
    iterations: defaultIterations,
    warmups: 2,
  },
  {
    name: "focused/direct-heap-call-literal",
    source: focusedSource,
    entryName: "direct_heap_call_literal",
    expected: 400_000_000,
    iterations: defaultIterations,
    warmups: 2,
  },
  {
    name: "focused/direct-heap-call-return",
    source: focusedSource,
    entryName: "direct_heap_call_return",
    expected: 400_000_000,
    iterations: defaultIterations,
    warmups: 2,
  },
  {
    name: "focused/escape-boundary-rematerialization",
    source: focusedSource,
    entryName: "escape_boundary_rematerialization",
    expected: 199_990_000,
    iterations: defaultIterations,
    warmups: 2,
  },
  {
    name: "representative/vtrace-compute-main",
    entryPath: path.join(
      import.meta.dirname,
      "..",
      "apps",
      "smoke",
      "fixtures",
      "vtrace-compute-benchmark.voyd",
    ),
    entryName: "main",
    expected: 3_825_271,
    iterations: representativeIterations,
    warmups: 1,
  },
  {
    name: "representative/scalar-aggregate-particle-step",
    entryPath: path.join(
      import.meta.dirname,
      "..",
      "apps",
      "smoke",
      "fixtures",
      "scalar-aggregate-representative.voyd",
    ),
    entryName: "main",
    expected: 1_100_340_000,
    iterations: representativeIterations,
    warmups: 1,
  },
  ...maybeFileScenario({
    name: "voyd-examples/suite-compile",
    entryPath: "/Users/drew/projects/voyd_examples/benchmarks/suite/voyd/benchmarks.voyd",
    optional: true,
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

const countMatches = (source: string, pattern: RegExp): number =>
  source.match(pattern)?.length ?? 0;

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
      emitWasmText: true,
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
    revision: revisionLabel,
    name: scenario.name,
    optimize,
    compileMs,
    wasmBytes: compiled.wasm.byteLength,
    gzipBytes: gzipSync(compiled.wasm).byteLength,
    wasmSha256: createHash("sha256").update(compiled.wasm).digest("hex"),
    wasmTextBytes: new TextEncoder().encode(compiled.wasmText ?? "").byteLength,
    structNewCount: countMatches(compiled.wasmText ?? "", /\(struct\.new /g),
    structNewDefaultCount: countMatches(
      compiled.wasmText ?? "",
      /\(struct\.new_default /g,
    ),
    tupleMakeCount: countMatches(compiled.wasmText ?? "", /\(tuple\.make/g),
    medianMs: median(samplesMs),
    samplesMs,
  };
};

const printResults = (results: readonly ScenarioResult[]): void => {
  console.log(
    "revision,name,optimize,compileMs,wasmBytes,gzipBytes,wasmTextBytes,structNewCount,structNewDefaultCount,tupleMakeCount,wasmSha256,medianMs,samplesMs",
  );
  results.forEach((result) => {
    console.log(
      [
        result.revision,
        result.name,
        result.optimize ? "true" : "false",
        result.compileMs.toFixed(3),
        result.wasmBytes.toString(),
        result.gzipBytes.toString(),
        result.wasmTextBytes.toString(),
        result.structNewCount.toString(),
        result.structNewDefaultCount.toString(),
        result.tupleMakeCount.toString(),
        result.wasmSha256,
        result.medianMs === undefined ? "" : result.medianMs.toFixed(3),
        result.samplesMs.map((sample) => sample.toFixed(3)).join("|"),
      ].join(","),
    );
  });
};

const parseResultsCsv = (filePath: string): ScenarioResult[] => {
  const lines = fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  const header = lines.shift()?.split(",");
  if (!header) {
    throw new Error(`${filePath} is empty`);
  }
  const revisionColumn = header[0] === "revision";
  const index = (column: string): number => {
    const columnIndex = header.indexOf(column);
    if (columnIndex < 0) {
      throw new Error(`${filePath} is missing ${column} column`);
    }
    return columnIndex;
  };

  const revisionIndex = revisionColumn ? index("revision") : undefined;
  const nameIndex = index("name");
  const optimizeIndex = index("optimize");
  const compileMsIndex = index("compileMs");
  const wasmBytesIndex = index("wasmBytes");
  const gzipBytesIndex = index("gzipBytes");
  const wasmTextBytesIndex = index("wasmTextBytes");
  const structNewCountIndex = index("structNewCount");
  const structNewDefaultCountIndex = index("structNewDefaultCount");
  const tupleMakeCountIndex = index("tupleMakeCount");
  const wasmSha256Index = index("wasmSha256");
  const medianMsIndex = index("medianMs");
  const samplesMsIndex = index("samplesMs");

  return lines.map((line) => {
    const columns = line.split(",");
    return {
      revision:
        typeof revisionIndex === "number" ? columns[revisionIndex] ?? "" : "unknown",
      name: columns[nameIndex] ?? "",
      optimize: columns[optimizeIndex] === "true",
      compileMs: Number.parseFloat(columns[compileMsIndex] ?? "0"),
      wasmBytes: Number.parseInt(columns[wasmBytesIndex] ?? "0", 10),
      gzipBytes: Number.parseInt(columns[gzipBytesIndex] ?? "0", 10),
      wasmTextBytes: Number.parseInt(columns[wasmTextBytesIndex] ?? "0", 10),
      structNewCount: Number.parseInt(columns[structNewCountIndex] ?? "0", 10),
      structNewDefaultCount: Number.parseInt(
        columns[structNewDefaultCountIndex] ?? "0",
        10,
      ),
      tupleMakeCount: Number.parseInt(columns[tupleMakeCountIndex] ?? "0", 10),
      wasmSha256: columns[wasmSha256Index] ?? "",
      medianMs:
        columns[medianMsIndex] && columns[medianMsIndex]!.length > 0
          ? Number.parseFloat(columns[medianMsIndex]!)
          : undefined,
      samplesMs:
        columns[samplesMsIndex]?.length
          ? columns[samplesMsIndex]!.split("|").map((sample) =>
              Number.parseFloat(sample),
            )
          : [],
    };
  });
};

const resultKey = (result: Pick<ScenarioResult, "name" | "optimize">): string =>
  `${result.name}\0${result.optimize ? "true" : "false"}`;

const percentDelta = (base: number, head: number): string =>
  base === 0 ? "" : (((head - base) / base) * 100).toFixed(1);

const formatMaybeMs = (value: number | undefined): string =>
  value === undefined ? "" : value.toFixed(3);

const printComparison = ({
  baseResults,
  headResults,
}: {
  baseResults: readonly ScenarioResult[];
  headResults: readonly ScenarioResult[];
}): void => {
  const baseByKey = new Map(baseResults.map((result) => [resultKey(result), result]));
  const matched = headResults
    .map((head) => ({ head, base: baseByKey.get(resultKey(head)) }))
    .filter(
      (entry): entry is { head: ScenarioResult; base: ScenarioResult } =>
        entry.base !== undefined,
    );

  console.log(
    "name,optimize,baseRevision,headRevision,compileMsBase,compileMsHead,compileMsDeltaPct,medianMsBase,medianMsHead,medianMsDeltaPct,wasmBytesBase,wasmBytesHead,wasmBytesDeltaPct,gzipBytesBase,gzipBytesHead,gzipBytesDeltaPct,wasmTextBytesBase,wasmTextBytesHead,wasmTextBytesDeltaPct,structNewBase,structNewHead,structNewDelta,structNewDefaultBase,structNewDefaultHead,structNewDefaultDelta,tupleMakeBase,tupleMakeHead,tupleMakeDelta,baseWasmSha256,headWasmSha256",
  );
  matched.forEach(({ base, head }) => {
    console.log(
      [
        head.name,
        head.optimize ? "true" : "false",
        base.revision,
        head.revision,
        base.compileMs.toFixed(3),
        head.compileMs.toFixed(3),
        percentDelta(base.compileMs, head.compileMs),
        formatMaybeMs(base.medianMs),
        formatMaybeMs(head.medianMs),
        base.medianMs === undefined || head.medianMs === undefined
          ? ""
          : percentDelta(base.medianMs, head.medianMs),
        base.wasmBytes.toString(),
        head.wasmBytes.toString(),
        percentDelta(base.wasmBytes, head.wasmBytes),
        base.gzipBytes.toString(),
        head.gzipBytes.toString(),
        percentDelta(base.gzipBytes, head.gzipBytes),
        base.wasmTextBytes.toString(),
        head.wasmTextBytes.toString(),
        percentDelta(base.wasmTextBytes, head.wasmTextBytes),
        base.structNewCount.toString(),
        head.structNewCount.toString(),
        (head.structNewCount - base.structNewCount).toString(),
        base.structNewDefaultCount.toString(),
        head.structNewDefaultCount.toString(),
        (head.structNewDefaultCount - base.structNewDefaultCount).toString(),
        base.tupleMakeCount.toString(),
        head.tupleMakeCount.toString(),
        (head.tupleMakeCount - base.tupleMakeCount).toString(),
        base.wasmSha256,
        head.wasmSha256,
      ].join(","),
    );
  });
};

const main = async (): Promise<void> => {
  const [command, baseCsv, headCsv] = process.argv.slice(2);
  if (command === "compare") {
    if (!baseCsv || !headCsv) {
      throw new Error("usage: bench-v326.ts compare <base.csv> <head.csv>");
    }
    printComparison({
      baseResults: parseResultsCsv(baseCsv),
      headResults: parseResultsCsv(headCsv),
    });
    return;
  }
  if (command) {
    throw new Error(`unknown command ${command}`);
  }

  const results: ScenarioResult[] = [];
  for (const scenario of scenarios) {
    for (const optimize of optimizeModes) {
      try {
        results.push(await runScenario({ scenario, optimize }));
      } catch (error) {
        if (!scenario.optional) {
          throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`skipping optional scenario ${scenario.name}: ${message}`);
      }
    }
  }
  printResults(results);
};

await main();
