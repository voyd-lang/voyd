import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { gzipSync } from "node:zlib";
import {
  AGGRESSIVE_BINARYEN_EXTRA_PASSES,
  type AggressiveBinaryenExtraPass,
} from "@voyd-lang/lib/binaryen-optimize.js";

type OptimizationMode = "unoptimized" | "balanced" | "release";
type BinaryenAblation = AggressiveBinaryenExtraPass | "final-optimize";

type CompilerPerfSummary = {
  schemaVersion?: number;
  phasesMs: Record<string, number>;
  counters: Record<string, number>;
  overlapped?: boolean;
};

type Scenario = {
  name: string;
  source?: string;
  entryPath?: string;
  entryName: string;
  expected: number;
  fullOnly?: boolean;
};

type WorkerConfig = {
  scenarioName: string;
  mode: OptimizationMode;
  runtimeSamples: number;
  collectArtifactDetails: boolean;
  sourceOverride?: string;
  binaryenAblation?: BinaryenAblation;
};

type CompileSample = {
  durationMs: number;
  peakHeapUsedBytes: number;
  peakRssBytes: number;
  phasesMs: Record<string, number>;
  counters: Record<string, number>;
  wasmBytes: number;
  wasmSha256: string;
  processMaxRssBytes: number;
  processMaxRssGrowthBytes: number;
};

type WorkerResult = {
  sample: CompileSample;
  gzipBytes?: number;
  runtimeSamplesMs: number[];
  wasmStructure?: Record<string, number>;
};

type ScorecardRow = {
  scenario: string;
  mode: OptimizationMode;
  experiment: string;
  compileMedianMs: number;
  compileSamplesMs: number[];
  peakHeapUsedMedianBytes: number;
  peakHeapUsedSamplesBytes: number[];
  peakRssMedianBytes: number;
  peakRssSamplesBytes: number[];
  processMaxRssBytes: number;
  processMaxRssSamplesBytes: number[];
  processMaxRssGrowthBytes: number;
  processMaxRssGrowthSamplesBytes: number[];
  wasmBytes: number;
  gzipBytes: number;
  wasmSha256: string;
  runtimeMedianMs: number;
  runtimeSamplesMs: number[];
  phaseMediansMs: Record<string, number>;
  counterMedians: Record<string, number>;
  optimizerPasses: Array<{
    slot: number;
    name: string;
    medianMs: number;
    changed: boolean;
    metrics: Record<string, number>;
  }>;
  codegenMetrics: Record<string, number>;
  wasmStructure: Record<string, number>;
};

const TIER_ONE_SOURCE = `trait Runner
  fn run(self) -> i32

obj Box {
  value: i32
}

impl Runner for Box
  fn run(self) -> i32
    self.value

fn add_one(value: i32) -> i32
  value + 1

fn dead<T>(value: T) -> T
  value

pub fn invoke<T: Runner>(runner: T) -> i32
  runner.run()

pub fn main() -> i32
  if add_one(40) == 41 then:
    invoke(Box { value: 7 })
  else:
    dead<i32>(0)
`;

const SCALAR_AGGREGATE_SOURCE = `obj Vec3 {
  x: i32,
  y: i32,
  z: i32
}

fn energy(vec: Vec3) -> i32
  vec.x + vec.y * 3 + vec.z * 5

fn step_particle(seed: i32) -> i32
  let ~velocity = Vec3 { x: seed, y: seed + 1, z: seed + 2 }
  velocity.x = velocity.x + 3
  velocity.y = velocity.y + velocity.x
  velocity.z = velocity.z + velocity.y
  energy(velocity)

pub fn main() -> i32
  var i = 0
  var total = 0
  while i < 10000:
    total = total + step_particle(i)
    i = i + 1
  total
`;

const CALL_SHAPE_SOURCE = `obj Some<T> {
  value: T
}

obj None {}

type Optional<T> = Some<T> | None

fn sum_default(n: i32, { step: i32 = 1 }) -> i32
  if
    n <= 0:
      0
    else:
      n + sum_default(n - step, step: step)

pub fn main() -> i32
  var i = 0
  var total = 0
  while i < 50000:
    total = total + sum_default(10) + sum_default(10, step: 2)
    i = i + 1
  total
`;

const SCENARIOS: readonly Scenario[] = [
  {
    name: "tier1-trait-call",
    source: TIER_ONE_SOURCE,
    entryName: "main",
    expected: 7,
  },
  {
    name: "scalar-aggregate",
    source: SCALAR_AGGREGATE_SOURCE,
    entryName: "main",
    expected: 1_100_340_000,
  },
  {
    name: "call-shape-defaults",
    source: CALL_SHAPE_SOURCE,
    entryName: "main",
    expected: 4_250_000,
  },
  {
    name: "std-math-transcendentals",
    entryPath: path.resolve(
      "apps/smoke/fixtures/std-math-transcendentals.voyd",
    ),
    entryName: "main",
    expected: 1,
    fullOnly: true,
  },
  {
    name: "vtrace-main",
    entryPath: path.resolve(
      "apps/smoke/fixtures/vtrace-compute-benchmark.voyd",
    ),
    entryName: "main",
    expected: 3_825_271,
    fullOnly: true,
  },
  {
    name: "effects-wide-return",
    entryPath: path.resolve(
      "apps/smoke/fixtures/optimized-wide-value-return.voyd",
    ),
    entryName: "trait_dispatch_effectful_wide_value_return",
    expected: 11,
    fullOnly: true,
  },
];

const median = (values: readonly number[]): number => {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
};

const medianRecords = (
  records: readonly Readonly<Record<string, number>>[],
): Record<string, number> => {
  const keys = new Set(records.flatMap((record) => Object.keys(record)));
  return Object.fromEntries(
    Array.from(keys)
      .sort()
      .map((key) => [key, median(records.map((record) => record[key] ?? 0))]),
  );
};

const countMatches = (source: string, pattern: RegExp): number =>
  source.match(pattern)?.length ?? 0;

const wasmStructure = ({
  wasmText,
  functionCount,
}: {
  wasmText: string;
  functionCount: number;
}): Record<string, number> => ({
  functions: functionCount,
  struct_new: countMatches(wasmText, /\(struct\.new\b/g),
  struct_new_default: countMatches(wasmText, /\(struct\.new_default\b/g),
  array_new: countMatches(wasmText, /\(array\.new(?:_|\b)/g),
  ref_cast: countMatches(wasmText, /\(ref\.cast\b/g),
  call_ref: countMatches(wasmText, /\(call_ref\b/g),
  tuple_make: countMatches(wasmText, /\(tuple\.make\b/g),
  call_shape_specializations: countMatches(
    wasmText,
    /\(func \$[^\s]+__call_shape_/g,
  ),
});

const optimizerPassRows = (
  counters: Readonly<Record<string, number>>,
): ScorecardRow["optimizerPasses"] => {
  const passPrefix = /^optimize\.pass\.(\d+)\.([^.]+)\.ms$/;
  return Object.entries(counters)
    .flatMap(([key, medianMs]) => {
      const match = passPrefix.exec(key);
      if (!match) {
        return [];
      }
      const slot = Number.parseInt(match[1]!, 10);
      const name = match[2]!;
      const prefix = `optimize.pass.${slot}.${name}.`;
      const metrics = Object.fromEntries(
        Object.entries(counters)
          .filter(
            ([candidate]) =>
              candidate.startsWith(prefix) &&
              candidate !== `${prefix}ms` &&
              candidate !== `${prefix}changed` &&
              candidate !== `${prefix}invalidates`,
          )
          .map(([candidate, value]) => [candidate.slice(prefix.length), value]),
      );
      return [
        {
          slot,
          name,
          medianMs,
          changed: (counters[`${prefix}changed`] ?? 0) > 0,
          metrics,
        },
      ];
    })
    .sort((left, right) => left.slot - right.slot);
};

const findScenario = (name: string): Scenario => {
  const scenario = SCENARIOS.find((candidate) => candidate.name === name);
  if (!scenario) {
    throw new Error(`unknown optimizer benchmark scenario ${name}`);
  }
  return scenario;
};

const compileOnce = async ({
  scenario,
  mode,
}: {
  scenario: Scenario;
  mode: OptimizationMode;
}): Promise<{
  sample: CompileSample;
  compiled: { wasm: Uint8Array };
}> => {
  const { createSdk } = await import("@voyd-lang/sdk");
  const perfSummaries: CompilerPerfSummary[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]): void => {
    const message = String(args[0] ?? "");
    const prefix = "[voyd:compiler:perf] ";
    if (message.startsWith(prefix)) {
      perfSummaries.push(
        JSON.parse(message.slice(prefix.length)) as CompilerPerfSummary,
      );
      return;
    }
    originalError(...args);
  };

  const processMaxRssBeforeCompileBytes = process.resourceUsage().maxRSS * 1024;
  let peakHeapUsedBytes = process.memoryUsage().heapUsed;
  let peakRssBytes = process.memoryUsage().rss;
  const memoryPoll = setInterval(() => {
    const usage = process.memoryUsage();
    peakHeapUsedBytes = Math.max(peakHeapUsedBytes, usage.heapUsed);
    peakRssBytes = Math.max(peakRssBytes, usage.rss);
  }, 5);
  const startedAt = performance.now();
  try {
    const result = await createSdk().compile({
      ...(scenario.source
        ? {
            entryPath: scenario.entryPath ?? `${scenario.name}.voyd`,
            source: scenario.source,
          }
        : { entryPath: scenario.entryPath }),
      // Keep the legacy switch alongside the explicit level so the release-only
      // PR gate can benchmark a parent revision that predates optimizationLevel.
      optimize: mode !== "unoptimized",
      optimizationLevel: mode === "unoptimized" ? "none" : mode,
    });
    const durationMs = performance.now() - startedAt;
    if (!result.success) {
      throw new Error(
        `${scenario.name} failed to compile:\n${result.diagnostics
          .map((diagnostic) => diagnostic.message)
          .join("\n")}`,
      );
    }
    const finalUsage = process.memoryUsage();
    peakHeapUsedBytes = Math.max(peakHeapUsedBytes, finalUsage.heapUsed);
    peakRssBytes = Math.max(peakRssBytes, finalUsage.rss);
    const perf = perfSummaries.at(-1);
    if (perf?.overlapped) {
      throw new Error(
        `${scenario.name} emitted an overlapped compiler perf session`,
      );
    }
    if (!WebAssembly.validate(result.wasm as BufferSource)) {
      throw new Error(`${scenario.name} emitted invalid WebAssembly`);
    }
    const processMaxRssBytes = process.resourceUsage().maxRSS * 1024;
    return {
      sample: {
        durationMs,
        peakHeapUsedBytes,
        peakRssBytes,
        phasesMs: perf?.phasesMs ?? {},
        counters: perf?.counters ?? {},
        wasmBytes: result.wasm.byteLength,
        wasmSha256: createHash("sha256").update(result.wasm).digest("hex"),
        processMaxRssBytes,
        processMaxRssGrowthBytes: Math.max(
          0,
          processMaxRssBytes - processMaxRssBeforeCompileBytes,
        ),
      },
      compiled: result,
    };
  } finally {
    clearInterval(memoryPoll);
    console.error = originalError;
  }
};

const runWorker = async (config: WorkerConfig): Promise<WorkerResult> => {
  const baseScenario = findScenario(config.scenarioName);
  const scenario =
    config.sourceOverride === undefined
      ? baseScenario
      : { ...baseScenario, source: config.sourceOverride };
  const { sample, compiled } = await compileOnce({
    scenario,
    mode: config.mode,
  });
  const runtimeSamplesMs: number[] = [];
  if (config.runtimeSamples > 0) {
    const { createVoydHost } = await import("@voyd-lang/sdk/js-host");
    const host = await createVoydHost({ wasm: compiled.wasm });
    const warmupResult = await host.run<number>(scenario.entryName);
    if (warmupResult !== scenario.expected) {
      throw new Error(
        `${scenario.name} returned ${warmupResult}, expected ${scenario.expected}`,
      );
    }
    for (let index = 0; index < config.runtimeSamples; index += 1) {
      const startedAt = performance.now();
      const result = await host.run<number>(scenario.entryName);
      runtimeSamplesMs.push(performance.now() - startedAt);
      if (result !== scenario.expected) {
        throw new Error(
          `${scenario.name} returned ${result}, expected ${scenario.expected}`,
        );
      }
    }
  }

  return {
    sample,
    gzipBytes: config.collectArtifactDetails
      ? gzipSync(compiled.wasm).byteLength
      : undefined,
    runtimeSamplesMs,
    wasmStructure: config.collectArtifactDetails
      ? await (async () => {
          const binaryen = (await import("binaryen")).default;
          const module = binaryen.readBinary(compiled.wasm);
          const text = module.emitText();
          const functionCount = module.getNumFunctions();
          module.dispose();
          return wasmStructure({ wasmText: text, functionCount });
        })()
      : undefined,
  };
};

type ControllerOptions = {
  preset: "quick" | "ci" | "full";
  scenarioNames: string[];
  modes: OptimizationMode[];
  compileWarmups: number;
  compileSamples: number;
  runtimeSamples: number;
  outputPath?: string;
  corpusSnapshot: Readonly<Record<string, string>>;
  binaryenAblations: BinaryenAblation[];
};

const argValue = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const parseNonNegativeInteger = ({
  value,
  fallback,
  name,
  positive = false,
}: {
  value?: string;
  fallback: number;
  name: string;
  positive?: boolean;
}): number => {
  const parsed = value === undefined ? fallback : Number.parseInt(value, 10);
  const minimum = positive ? 1 : 0;
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}`);
  }
  return parsed;
};

const parseControllerOptions = (): ControllerOptions => {
  const presetValue = argValue("--preset") ?? "quick";
  if (
    presetValue !== "quick" &&
    presetValue !== "ci" &&
    presetValue !== "full"
  ) {
    throw new Error(`unknown optimizer benchmark preset ${presetValue}`);
  }
  const preset = presetValue;
  const defaultScenarios = SCENARIOS.filter(
    (scenario) =>
      preset === "full" ||
      !scenario.fullOnly ||
      (preset === "ci" && scenario.name === "vtrace-main"),
  ).map((scenario) => scenario.name);
  const scenarioNames = (argValue("--scenarios") ?? defaultScenarios.join(","))
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  scenarioNames.forEach(findScenario);
  const rawModeValues = (
    argValue("--modes") ??
    (preset === "full" ? "unoptimized,balanced,release" : "release")
  )
    .split(",")
    .map((value) => value.trim());
  const modeValues = Array.from(
    new Set(
      rawModeValues.map((mode) => (mode === "optimized" ? "release" : mode)),
    ),
  );
  if (
    modeValues.some(
      (mode) =>
        mode !== "unoptimized" && mode !== "balanced" && mode !== "release",
    )
  ) {
    throw new Error(`invalid optimizer modes ${rawModeValues.join(",")}`);
  }
  const ablationMatrix = process.argv.includes("--binaryen-ablation-matrix");
  const ablationValue = argValue("--binaryen-ablation");
  if (ablationMatrix && ablationValue) {
    throw new Error(
      "--binaryen-ablation and --binaryen-ablation-matrix cannot be combined",
    );
  }
  const validAblations: readonly string[] = [
    ...AGGRESSIVE_BINARYEN_EXTRA_PASSES,
    "final-optimize",
  ];
  if (ablationValue && !validAblations.includes(ablationValue)) {
    throw new Error(`unknown Binaryen ablation target ${ablationValue}`);
  }
  const defaults =
    preset === "quick"
      ? { compileWarmups: 0, compileSamples: 1, runtimeSamples: 3 }
      : { compileWarmups: 1, compileSamples: 3, runtimeSamples: 5 };
  const corpusSnapshotPath = argValue("--corpus-snapshot");
  const corpusSnapshot = corpusSnapshotPath
    ? JSON.parse(readFileSync(corpusSnapshotPath, "utf8"))
    : {};
  if (
    typeof corpusSnapshot !== "object" ||
    corpusSnapshot === null ||
    Array.isArray(corpusSnapshot) ||
    Object.values(corpusSnapshot).some((value) => typeof value !== "string")
  ) {
    throw new Error(
      "--corpus-snapshot must contain a JSON object of source strings",
    );
  }
  return {
    preset,
    scenarioNames,
    modes: modeValues as OptimizationMode[],
    compileWarmups: parseNonNegativeInteger({
      value: argValue("--compile-warmups"),
      fallback: defaults.compileWarmups,
      name: "--compile-warmups",
    }),
    compileSamples: parseNonNegativeInteger({
      value: argValue("--compile-samples"),
      fallback: defaults.compileSamples,
      name: "--compile-samples",
      positive: true,
    }),
    runtimeSamples: parseNonNegativeInteger({
      value: argValue("--runtime-samples"),
      fallback: defaults.runtimeSamples,
      name: "--runtime-samples",
      positive: true,
    }),
    outputPath: argValue("--output"),
    corpusSnapshot: corpusSnapshot as Record<string, string>,
    binaryenAblations: ablationMatrix
      ? [...AGGRESSIVE_BINARYEN_EXTRA_PASSES, "final-optimize"]
      : ablationValue
        ? [ablationValue as BinaryenAblation]
        : [],
  };
};

const gitRevision = (): string | undefined => {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : undefined;
};

const runWorkerProcess = (config: WorkerConfig): WorkerResult => {
  const env = { ...process.env, VOYD_COMPILER_PERF: "1" };
  delete env.VOYD_INTERNAL_BINARYEN_ABLATION;
  delete env.VOYD_BINARYEN_EXPERIMENT;
  if (config.binaryenAblation) {
    env.VOYD_INTERNAL_BINARYEN_ABLATION = "1";
    env.VOYD_BINARYEN_EXPERIMENT = JSON.stringify(
      config.binaryenAblation === "final-optimize"
        ? { skipFinalOptimize: true }
        : { disabledExtraPasses: [config.binaryenAblation] },
    );
  }
  const result = spawnSync(
    process.execPath,
    [
      "--conditions=development",
      "--import",
      "tsx",
      path.resolve(import.meta.filename),
      "--worker-config",
      Buffer.from(JSON.stringify(config)).toString("base64url"),
    ],
    {
      cwd: process.cwd(),
      env,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `optimizer benchmark worker failed for ${config.scenarioName}/${config.mode}:\n${result.stderr}`,
    );
  }
  return JSON.parse(result.stdout) as WorkerResult;
};

const runScorecardCase = ({
  scenarioName,
  mode,
  binaryenAblation,
  options,
}: {
  scenarioName: string;
  mode: OptimizationMode;
  binaryenAblation?: BinaryenAblation;
  options: ControllerOptions;
}): ScorecardRow => {
  for (let index = 0; index < options.compileWarmups; index += 1) {
    runWorkerProcess({
      scenarioName,
      mode,
      runtimeSamples: 0,
      collectArtifactDetails: false,
      sourceOverride: options.corpusSnapshot[scenarioName],
      binaryenAblation,
    });
  }

  const results = Array.from({ length: options.compileSamples }, (_, index) =>
    runWorkerProcess({
      scenarioName,
      mode,
      runtimeSamples:
        index === options.compileSamples - 1 ? options.runtimeSamples : 0,
      collectArtifactDetails: index === options.compileSamples - 1,
      sourceOverride: options.corpusSnapshot[scenarioName],
      binaryenAblation,
    }),
  );
  const samples = results.map((result) => result.sample);
  const artifactHashes = new Set(samples.map((sample) => sample.wasmSha256));
  const artifactSizes = new Set(samples.map((sample) => sample.wasmBytes));
  if (artifactHashes.size !== 1 || artifactSizes.size !== 1) {
    throw new Error(
      `${scenarioName}/${mode}/${binaryenAblation ?? "baseline"} emitted nondeterministic WebAssembly across identical compiles`,
    );
  }
  const artifact = results.at(-1);
  if (
    !artifact ||
    typeof artifact.gzipBytes !== "number" ||
    !artifact.wasmStructure
  ) {
    throw new Error(`${scenarioName}/${mode} did not produce artifact details`);
  }
  const phaseMediansMs = medianRecords(
    samples.map((sample) => sample.phasesMs),
  );
  const counterMedians = medianRecords(
    samples.map((sample) => sample.counters),
  );

  return {
    scenario: scenarioName,
    mode,
    experiment: binaryenAblation ? `without:${binaryenAblation}` : "baseline",
    compileMedianMs: median(samples.map((sample) => sample.durationMs)),
    compileSamplesMs: samples.map((sample) => sample.durationMs),
    peakHeapUsedMedianBytes: median(
      samples.map((sample) => sample.peakHeapUsedBytes),
    ),
    peakHeapUsedSamplesBytes: samples.map((sample) => sample.peakHeapUsedBytes),
    peakRssMedianBytes: median(samples.map((sample) => sample.peakRssBytes)),
    peakRssSamplesBytes: samples.map((sample) => sample.peakRssBytes),
    processMaxRssBytes: median(
      samples.map((sample) => sample.processMaxRssBytes),
    ),
    processMaxRssSamplesBytes: samples.map(
      (sample) => sample.processMaxRssBytes,
    ),
    processMaxRssGrowthBytes: median(
      samples.map((sample) => sample.processMaxRssGrowthBytes),
    ),
    processMaxRssGrowthSamplesBytes: samples.map(
      (sample) => sample.processMaxRssGrowthBytes,
    ),
    wasmBytes: artifact.sample.wasmBytes,
    gzipBytes: artifact.gzipBytes,
    wasmSha256: artifact.sample.wasmSha256,
    runtimeMedianMs: median(artifact.runtimeSamplesMs),
    runtimeSamplesMs: artifact.runtimeSamplesMs,
    phaseMediansMs,
    counterMedians,
    optimizerPasses: optimizerPassRows(counterMedians),
    codegenMetrics: Object.fromEntries(
      Object.entries(counterMedians).filter(([key]) =>
        key.startsWith("codegen."),
      ),
    ),
    wasmStructure: artifact.wasmStructure,
  };
};

const runController = (options: ControllerOptions): void => {
  if (process.argv.includes("--print-plan")) {
    process.stdout.write(
      `${JSON.stringify({ scenarioNames: options.scenarioNames })}\n`,
    );
    return;
  }
  const rows = options.scenarioNames.flatMap((scenarioName) =>
    options.modes.flatMap((mode) =>
      [undefined, ...(mode === "release" ? options.binaryenAblations : [])].map(
        (binaryenAblation) =>
          runScorecardCase({
            scenarioName,
            mode,
            binaryenAblation,
            options,
          }),
      ),
    ),
  );
  const scorecard = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    revision: gitRevision(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    preset: options.preset,
    corpusHashes: Object.fromEntries(
      options.scenarioNames.map((scenarioName) => {
        const scenario = findScenario(scenarioName);
        const source =
          options.corpusSnapshot[scenarioName] ??
          scenario.source ??
          readFileSync(scenario.entryPath!, "utf8");
        return [
          scenarioName,
          createHash("sha256").update(source).digest("hex"),
        ];
      }),
    ),
    rows,
  };
  const output = `${JSON.stringify(scorecard, null, 2)}\n`;
  if (options.outputPath) {
    writeFileSync(options.outputPath, output);
  }
  process.stdout.write(output);
};

const workerConfigValue = argValue("--worker-config");
if (workerConfigValue) {
  const config = JSON.parse(
    Buffer.from(workerConfigValue, "base64url").toString("utf8"),
  ) as WorkerConfig;
  process.stdout.write(`${JSON.stringify(await runWorker(config))}\n`);
} else {
  runController(parseControllerOptions());
}
