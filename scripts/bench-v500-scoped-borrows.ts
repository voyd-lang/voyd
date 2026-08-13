import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, release, totalmem } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

type OptimizationMode = "none" | "balanced" | "release";
type BorrowSyntaxDialect = "scoped-generic" | "legacy-prefix";
type WorkloadFamily =
  | "ordinary-fields"
  | "ordinary-topology"
  | "borrow-calls"
  | "borrow-depth"
  | "borrow-callbacks"
  | "mutation-mixed";

type Scenario = {
  name: string;
  family: WorkloadFamily;
  scale: number;
  source: string;
  expected: number;
  dimensions: Record<string, number>;
  explicitBorrow: boolean;
};

type Repository = {
  label: string;
  repository: string;
  revision: string;
  dirty: boolean;
  borrowSyntaxDialect: BorrowSyntaxDialect;
  borrowSyntaxDetection: {
    strategy: "type-display-source-marker";
    evidenceFile: string;
    evidenceSha256: string;
  };
};

type CompilerPerfSummary = {
  phasesMs?: Record<string, number>;
  counters?: Record<string, number>;
  overlapped?: boolean;
};

type Diagnostic = {
  code?: string;
  message?: string;
};

type CompileResult =
  | {
      success: true;
      wasm: Uint8Array;
      diagnostics?: readonly Diagnostic[];
    }
  | {
      success: false;
      diagnostics: readonly Diagnostic[];
    };

type SdkModule = {
  createSdk: (options?: { compilerCache?: "none" | "memory" }) => {
    compile: (options: {
      entryPath: string;
      source: string;
      optimize: boolean;
      optimizationLevel: OptimizationMode;
      boundaryExports: boolean;
      effectsHostBoundary: "off";
    }) => Promise<CompileResult>;
  };
};

type HostModule = {
  createVoydHost: (options: { wasm: Uint8Array }) => Promise<{
    runPure: <T>(entryName: string) => Promise<T>;
  }>;
};

type WorkerConfig = {
  repository: string;
  borrowSyntaxDialect: BorrowSyntaxDialect;
  scenario: Scenario;
  mode: OptimizationMode;
  runtimeSamples: number;
  runtimeSampleMinMs: number;
  warmSourceEdit: boolean;
};

type Sample = {
  compileSuccess: boolean;
  primingDurationMs: number | null;
  durationMs: number;
  peakHeapUsedBytes: number;
  peakRssBytes: number;
  processMaxRssBytes: number;
  processMaxRssGrowthBytes: number;
  phasesMs: Record<string, number>;
  counters: Record<string, number>;
  wasmBytes: number | null;
  wasmSha256: string | null;
  diagnostics: Diagnostic[];
  runtimeSamplesMs: number[];
};

type WorkerResult = { sample: Sample };

type ControllerOptions = {
  repositories: Repository[];
  scenarios: Scenario[];
  modes: OptimizationMode[];
  sampleCount: number;
  warmupCount: number;
  runtimeSamples: number;
  runtimeSampleMinMs: number;
  failOnDiagnostics: boolean;
  warmSourceEdit: boolean;
  outputPath?: string;
};

type Distribution = {
  values: number[];
  min: number;
  median: number;
  p95: number;
  max: number;
};

type RequiredMetrics = {
  totalCompilationMs: number;
  totalSemanticMs: number | null;
  ordinaryMutationAnalysisMs: number | null;
  explicitBorrowAnalysisMs: number | null;
  callableCount: number | null;
  callEdgeCount: number | null;
  ordinarySummaryEvaluations: number | null;
  ordinarySccReevaluations: number | null;
  explicitBorrowFactCount: number | null;
  projectionFamilyCount: number | null;
  wideningCount: number | null;
  retainedSummaryBytes: number | null;
  peakRssBytes: number;
  wasmBytes: number | null;
  runtimeMedianMs: number | null;
};

type ResultRow = {
  repository: string;
  revision: string;
  scenario: string;
  family: WorkloadFamily;
  scale: number;
  dimensions: Record<string, number>;
  explicitBorrow: boolean;
  compileKind: "cold" | "warm-source-only-edit";
  sourceDialect: BorrowSyntaxDialect;
  canonicalSourceSha256: string;
  canonicalPrimingSourceSha256: string | null;
  sourceSha256: string;
  primingSourceSha256: string | null;
  borrowSyntaxReplacementCount: number;
  sourceBytes: number;
  sourceLines: number;
  mode: OptimizationMode;
  compileSuccessRate: number;
  diagnosticSignatures: string[];
  compileMs: Distribution;
  primingCompileMs: Distribution | null;
  peakHeapUsedBytes: Distribution;
  peakRssBytes: Distribution;
  processMaxRssBytes: Distribution;
  processMaxRssGrowthBytes: Distribution;
  wasmBytes: number | null;
  wasmSha256: string | null;
  runtimeMs: Distribution | null;
  phaseMediansMs: Record<string, number>;
  counterMedians: Record<string, number>;
  optimizerDispositionCounters: Record<string, number>;
  requiredMetrics: RequiredMetrics;
  missingRequiredMetrics: string[];
  samples: Sample[];
};

type AcceptanceWorkload = {
  id: string;
  adrCriterion: string;
  owner: string;
  command: string;
  coverage: "ready" | "partial";
  requiredEvidence: readonly string[];
  note?: string;
};

const HELP = `V-500 scoped-borrow compiler benchmark

Usage:
  npm run bench:v500 -- [options]

Options:
  --repo LABEL=/absolute/path    Checkout to measure; repeat to compare revisions.
                                 Defaults to current=<cwd>.
  --families LIST               Comma-separated generated families or all.
                                 Default: all.
  --sizes LIST                  Positive growth points. Default: 4,8,16,32.
  --scenario NAME               Run one generated scenario; repeat as needed.
  --modes LIST                  none, balanced, and/or release.
                                 Default: none,release.
  --samples N                   Fresh-process compile samples. Default: 5.
  --warmups N                   Discarded fresh-process samples. Default: 1.
  --runtime-samples N           Timed run groups on the last release artifact.
                                 Default: 0.
  --runtime-min-ms N            Minimum duration of each timed run group.
                                 Default: 100.
  --warm-source-edit            Prime one memory-cached SDK, then time a
                                 comment-only edit at the same entry path.
  --fail-on-diagnostics         Stop if a generated source does not compile.
  --output PATH                 Also write the JSON report to PATH.
  --list                        Print generated scenario metadata and exit.
  --list-workloads              Print the complete ADR acceptance plan and exit.
  --help                        Print this help.

Families:
  ordinary-fields, ordinary-topology, borrow-calls, borrow-depth,
  borrow-callbacks, mutation-mixed

Every measured compile runs in a fresh Node process. With multiple --repo
arguments, repository order alternates for each sample. The first repository
is the ratio baseline. The runner detects whether each checkout spells scoped
borrows as Borrow<T> or legacy borrow T and renders the same canonical scenario
for that syntax. Source hashes, dialects, phases, counters, samples, scaling
points, and same-machine ratios are retained in the JSON output.
`;

const ALL_FAMILIES: readonly WorkloadFamily[] = [
  "ordinary-fields",
  "ordinary-topology",
  "borrow-calls",
  "borrow-depth",
  "borrow-callbacks",
  "mutation-mixed",
];

const ACCEPTANCE_WORKLOADS: readonly AcceptanceWorkload[] = [
  {
    id: "generated-ordinary-dto-scaling",
    adrCriterion: "1-2",
    owner: "bench:v500",
    command:
      "npm run bench:v500 -- --families ordinary-fields,ordinary-topology --sizes 4,8,16,32 --modes none,release --samples 7 --warmups 1 --output /tmp/v500-ordinary.json",
    coverage: "ready",
    requiredEvidence: [
      "four independently generated growth points",
      "phase and counter distributions",
      "retained-summary, zero-projection, zero-widening, and zero-explicit-fact gates",
    ],
  },
  {
    id: "generated-explicit-borrow-scaling",
    adrCriterion: "3",
    owner: "bench:v500",
    command:
      "npm run bench:v500 -- --families borrow-calls,borrow-depth,borrow-callbacks --sizes 4,8,16,32 --modes none,release --samples 7 --warmups 1 --output /tmp/v500-explicit-borrow.json",
    coverage: "ready",
    requiredEvidence: [
      "independent Borrow-aware call, projection-depth, and scoped-callback series",
      "explicit parameter-fact counts and explicit-analysis time",
    ],
  },
  {
    id: "generated-mutation-shape-scaling",
    adrCriterion: "4",
    owner: "bench:v500",
    command:
      "npm run bench:v500 -- --families mutation-mixed --sizes 4,8,16,32 --modes none,release --samples 7 --warmups 1 --output /tmp/v500-mutation.json",
    coverage: "ready",
    requiredEvidence: [
      "direct, dynamic, callback, ambient, identity-guard, and SCC dimensions",
      "summary evaluation and SCC reevaluation scaling",
    ],
  },
  {
    id: "pkg-web-cold-compile",
    adrCriterion: "5",
    owner: "bench:web-openapi",
    command:
      "npm run bench:web-openapi -- --repo base=/absolute/path/to/base --repo head=/absolute/path/to/head --compiler-cache none --compile-count 1 --warmups 1 --samples 7 --require-clean --output /tmp/v500-web-openapi-base-head.json",
    coverage: "ready",
    requiredEvidence: [
      "alternating clean revision order with one discarded warmup and seven fresh-process samples",
      "revision, dirty-state, fixture, source, dependency, and installed-dependency hashes",
      "cold compiler phases and counters",
      "raw child stdout, stderr, and compiler summaries",
      "wall-time and process max-RSS distributions",
      "complete closed V-500 counter schema including zeros",
    ],
  },
  {
    id: "representative-full-stack-application",
    adrCriterion: "5",
    owner: "bench:v439",
    command:
      "npm run bench:v439 -- --scenario representative-web-app-request --samples 7 --runtime-samples 31 --output /tmp/v500-full-stack.json",
    coverage: "ready",
    requiredEvidence: [
      "compile and runtime distributions",
      "Wasm size and checksum",
      "emitted code shape",
    ],
  },
  {
    id: "warm-source-only-edit",
    adrCriterion: "6",
    owner: "bench:v500",
    command:
      "npm run bench:v500 -- --scenario ordinary-topology-16 --modes none --samples 7 --warmups 1 --warm-source-edit --output /tmp/v500-warm-edit.json",
    coverage: "ready",
    requiredEvidence: [
      "same SDK instance and entry path",
      "memory cache primed by the unedited source",
      "timed compile after a source-only comment edit",
    ],
  },
  {
    id: "historical-v499-selected-provider",
    adrCriterion: "7",
    owner: "compiler export-ABI performance control",
    command:
      "VOYD_COMPILER_PERF=1 npx vitest run --config vitest.config.ts --testTimeout 120000 --hookTimeout 120000 packages/compiler/src/codegen/__tests__/export-abi.test.ts -t 'avoids wrapper export name collisions with user exports' --reporter=dot --disableConsoleIntercept",
    coverage: "partial",
    requiredEvidence: [
      "selected-provider compile phase and counter summaries",
      "repeated same-machine base/head samples",
    ],
    note: "The historical Vitest control emits one compiler sample per run; preserve repeated raw summaries externally.",
  },
  {
    id: "historical-v499-host-boundary-disabled",
    adrCriterion: "7",
    owner: "bench:optimizer",
    command:
      "npm run bench:optimizer -- --preset full --scenarios vtrace-main --modes unoptimized --compile-warmups 1 --compile-samples 7 --runtime-samples 9 --output /tmp/v500-v499-host-boundary-off.json",
    coverage: "ready",
    requiredEvidence: [
      "effects host boundary and boundary exports disabled",
      "compiler phase and counter distributions",
    ],
  },
  {
    id: "stable-fixed-field-forwarding",
    adrCriterion: "8",
    owner: "bench:v439 plus focused emitted-shape test",
    command:
      "npm run bench:v439 -- --scenario focused-checked-access --samples 7 --runtime-samples 31 --output /tmp/v500-checked-access.json",
    coverage: "ready",
    requiredEvidence: [
      "stable-field forwarding acceptance/fallback counters",
      "runtime, Wasm size, and struct-load shape",
    ],
  },
  {
    id: "fresh-mutable-aggregate-promotion",
    adrCriterion: "8",
    owner: "bench:mutable-result",
    command:
      "npm run bench:mutable-result -- --compile-samples 7 --runtime-samples 31 --output /tmp/v500-mutable-result.json",
    coverage: "ready",
    requiredEvidence: [
      "fresh exact-call acceptance and fallback counters",
      "runtime, Wasm size, allocations, and field traffic",
    ],
  },
  {
    id: "counted-array-fast-path",
    adrCriterion: "8",
    owner: "bench:v439 focused checked access",
    command:
      "npm run bench:v439 -- --scenario focused-checked-access --samples 7 --runtime-samples 31 --output /tmp/v500-checked-access.json",
    coverage: "ready",
    requiredEvidence: [
      "checked-array versus optional-array runtime",
      "Wasm size, array access shape, and acceptance/fallback counters",
    ],
  },
  {
    id: "range-fast-path",
    adrCriterion: "8",
    owner: "bench:v439 isolated Range optimizations",
    command:
      "npm run bench:v439 -- --scenario isolated-range-optimizations --samples 7 --runtime-samples 31 --output /tmp/v500-range-optimizations.json",
    coverage: "ready",
    requiredEvidence: [
      "separate direct Range and Range-derived Array runtime distributions",
      "whole-module and per-export Wasm shape and size",
      "intrinsic Range and Range/Array safe-scope disposition counters",
    ],
  },
  {
    id: "deferred-default-guard-companion",
    adrCriterion: "8",
    owner: "bench:v439 deferred-default identity guard",
    command:
      "npm run bench:v439 -- --scenario deferred-default-identity-guard --samples 7 --runtime-samples 31 --output /tmp/v500-deferred-default-guard.json",
    coverage: "ready",
    requiredEvidence: [
      "deferred-default guard runtime distribution and Wasm companion shape",
      "nonzero guard emission and companion requested, created, and compiled counters",
      "raw compiler phase, counter, compile, runtime, and peak-RSS samples",
    ],
  },
  {
    id: "intrinsic-array-iteration",
    adrCriterion: "8",
    owner: "bench:array-for",
    command:
      "npm run bench:array-for -- --compile-samples 7 --runtime-samples 31 --output /tmp/v500-array-for.json",
    coverage: "ready",
    requiredEvidence: [
      "for-loop versus indexed controls",
      "runtime, Wasm size, allocation, and indirect-call shape",
    ],
  },
  {
    id: "exact-iterator-specialization",
    adrCriterion: "8",
    owner: "bench:iterator-for",
    command:
      "npm run bench:iterator-for -- --compile-samples 7 --runtime-samples 31 --output /tmp/v500-iterator-for.json",
    coverage: "ready",
    requiredEvidence: [
      "specialized versus manual controls",
      "runtime, Wasm size, allocation, and dispatch shape",
    ],
  },
];

const valuesAfter = (name: string): string[] =>
  process.argv.flatMap((value, index) =>
    value === name && process.argv[index + 1] ? [process.argv[index + 1]!] : [],
  );

const valueAfter = (name: string): string | undefined => valuesAfter(name)[0];

const parseInteger = ({
  name,
  fallback,
  minimum,
}: {
  name: string;
  fallback: number;
  minimum: number;
}): number => {
  const value = Number.parseInt(valueAfter(name) ?? String(fallback), 10);
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer of at least ${minimum}`);
  }
  return value;
};

const parseNumber = ({
  name,
  fallback,
  minimum,
}: {
  name: string;
  fallback: number;
  minimum: number;
}): number => {
  const value = Number(valueAfter(name) ?? fallback);
  if (!Number.isFinite(value) || value < minimum) {
    throw new Error(`${name} must be a number of at least ${minimum}`);
  }
  return value;
};

const parseList = (value: string): string[] =>
  value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

const parseSizes = (): number[] => {
  const sizes = Array.from(
    new Set(
      parseList(valueAfter("--sizes") ?? "4,8,16,32").map((entry) =>
        Number.parseInt(entry, 10),
      ),
    ),
  ).sort((left, right) => left - right);
  if (
    sizes.length === 0 ||
    sizes.some((size) => !Number.isSafeInteger(size) || size < 1)
  ) {
    throw new Error("--sizes must contain positive integers");
  }
  return sizes;
};

const parseFamilies = (): WorkloadFamily[] => {
  const requested = parseList(valueAfter("--families") ?? "all");
  if (requested.length === 1 && requested[0] === "all") {
    return [...ALL_FAMILIES];
  }
  const invalid = requested.filter(
    (family) => !ALL_FAMILIES.includes(family as WorkloadFamily),
  );
  if (invalid.length > 0 || requested.length === 0) {
    throw new Error(`unsupported --families entries: ${invalid.join(", ")}`);
  }
  return requested as WorkloadFamily[];
};

const parseModes = (): OptimizationMode[] => {
  const modes = parseList(
    valueAfter("--modes") ?? "none,release",
  ) as OptimizationMode[];
  const supported: readonly OptimizationMode[] = [
    "none",
    "balanced",
    "release",
  ];
  const invalid = modes.filter((mode) => !supported.includes(mode));
  if (invalid.length > 0 || modes.length === 0) {
    throw new Error(`unsupported --modes entries: ${invalid.join(", ")}`);
  }
  return Array.from(new Set(modes));
};

const gitOutput = (repository: string, args: string[]): string => {
  const result = spawnSync("git", args, {
    cwd: repository,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed in ${repository}: ${result.stderr}`,
    );
  }
  return result.stdout.trim();
};

const BORROW_DIALECT_EVIDENCE_FILE =
  "packages/compiler/src/semantics/typing/type-arena.ts";
const SCOPED_BORROW_DISPLAY_MARKER =
  "return `Borrow<${typeDescriptorToUserString(arena.get(type.inner), arena)}>`;";
const LEGACY_BORROW_DISPLAY_MARKER =
  "return `borrow ${typeDescriptorToUserString(arena.get(type.inner), arena)}`;";

const detectBorrowSyntax = (
  repository: string,
): Pick<Repository, "borrowSyntaxDialect" | "borrowSyntaxDetection"> => {
  const evidencePath = path.join(repository, BORROW_DIALECT_EVIDENCE_FILE);
  const evidence = readFileSync(evidencePath, "utf8");
  const hasScopedMarker = evidence.includes(SCOPED_BORROW_DISPLAY_MARKER);
  const hasLegacyMarker = evidence.includes(LEGACY_BORROW_DISPLAY_MARKER);
  if (hasScopedMarker === hasLegacyMarker) {
    throw new Error(
      `cannot determine borrow syntax in ${repository}: expected exactly one ` +
        `known marker in ${BORROW_DIALECT_EVIDENCE_FILE}`,
    );
  }
  return {
    borrowSyntaxDialect: hasScopedMarker ? "scoped-generic" : "legacy-prefix",
    borrowSyntaxDetection: {
      strategy: "type-display-source-marker",
      evidenceFile: BORROW_DIALECT_EVIDENCE_FILE,
      evidenceSha256: createHash("sha256").update(evidence).digest("hex"),
    },
  };
};

const parseRepositories = (): Repository[] => {
  const entries = valuesAfter("--repo");
  const requested = entries.length > 0 ? entries : [`current=${process.cwd()}`];
  const repositories = requested.map((entry) => {
    const separator = entry.indexOf("=");
    if (separator <= 0) {
      throw new Error("--repo must use LABEL=/absolute/path");
    }
    const label = entry.slice(0, separator);
    const repository = path.resolve(entry.slice(separator + 1));
    if (!existsSync(path.join(repository, "packages/sdk/src/index.ts"))) {
      throw new Error(`${repository} is not an installed Voyd checkout`);
    }
    return {
      label,
      repository,
      revision: gitOutput(repository, ["rev-parse", "HEAD"]),
      dirty: gitOutput(repository, ["status", "--porcelain"]).length > 0,
      ...detectBorrowSyntax(repository),
    };
  });
  if (
    new Set(repositories.map(({ label }) => label)).size !== repositories.length
  ) {
    throw new Error("--repo labels must be unique");
  }
  return repositories;
};

const lines = (count: number, render: (index: number) => string): string =>
  Array.from({ length: count }, (_, index) => render(index)).join("\n");

const objectFields = (count: number): string =>
  lines(count, (index) => `  field_${index}: i32,`);

const objectValues = (count: number, seed: number): string =>
  lines(count, (index) => `    field_${index}: ${seed + index},`);

const sourceAfterWarmEdit = (source: string): string =>
  `${source.trimEnd()}\n\n// V-500 warm source-only edit\n`;

type RenderedSource = {
  source: string;
  borrowSyntaxReplacementCount: number;
};

const isIdentifierCharacter = (value: string | undefined): boolean =>
  value !== undefined && /[A-Za-z0-9_]/.test(value);

const matchingGenericClose = (source: string, openIndex: number): number => {
  let depth = 1;
  for (let index = openIndex + 1; index < source.length; index += 1) {
    const character = source[index];
    if (character === "<") depth += 1;
    if (character !== ">" || source[index - 1] === "-") continue;
    depth -= 1;
    if (depth === 0) return index;
  }
  throw new Error("generated source contains an unterminated Borrow<T> type");
};

/**
 * Render the canonical scoped spelling for the selected compiler revision.
 * Generated workloads use only the intersection of the two borrow models; the
 * adapter changes the type spelling and never inserts a contract or capability.
 */
const renderSourceForDialect = (
  source: string,
  dialect: BorrowSyntaxDialect,
): RenderedSource => {
  if (dialect === "scoped-generic") {
    return { source, borrowSyntaxReplacementCount: 0 };
  }

  let rendered = "";
  let replacementCount = 0;
  let copiedThrough = 0;
  for (let index = 0; index < source.length; index += 1) {
    if (!source.startsWith("Borrow", index)) continue;
    if (
      isIdentifierCharacter(source[index - 1]) ||
      isIdentifierCharacter(source[index + "Borrow".length])
    ) {
      continue;
    }
    let openIndex = index + "Borrow".length;
    while (/\s/.test(source[openIndex] ?? "")) openIndex += 1;
    if (source[openIndex] !== "<") continue;

    const closeIndex = matchingGenericClose(source, openIndex);
    const inner = renderSourceForDialect(
      source.slice(openIndex + 1, closeIndex),
      dialect,
    );
    rendered += source.slice(copiedThrough, index);
    rendered += `borrow ${inner.source}`;
    replacementCount += inner.borrowSyntaxReplacementCount + 1;
    index = closeIndex;
    copiedThrough = closeIndex + 1;
  }
  rendered += source.slice(copiedThrough);
  if (rendered.includes("Borrow<")) {
    throw new Error("legacy borrow renderer left a canonical Borrow<T> type");
  }
  return { source: rendered, borrowSyntaxReplacementCount: replacementCount };
};

const ordinaryFieldsScenario = (scale: number): Scenario => {
  const source = `#!no_prelude
trait DtoScore
  fn score(self) -> i32

obj GenericBox<T> {
  value: T
}

obj DtoRecord {
${objectFields(scale)}
  nested: GenericBox<i32>
}

obj DtoRecordChoice {
  value: DtoRecord
}

obj DtoFallbackChoice {
  value: i32
}

type DtoChoice = DtoRecordChoice | DtoFallbackChoice

impl DtoScore for DtoRecord
  fn score(self) -> i32
    self.field_0 + self.nested.value

fn dynamic_score(value: DtoScore) -> i32
  value.score()

fn projected_mutation(~value: DtoRecord) -> void
  value.field_0 = value.field_0 + 2
  value.nested.value = value.nested.value + 1

fn choice_score(value: DtoChoice) -> i32
  match(value)
    DtoRecordChoice { value: record }: dynamic_score(record)
    DtoFallbackChoice { value }: value

pub fn main() -> i32
  let ~value = DtoRecord {
${objectValues(scale, 0)}
    nested: GenericBox<i32> { value: ${scale} }
  }
  projected_mutation(~value)
  dynamic_score(value) + choice_score(DtoRecordChoice { value })
`;
  return {
    name: `ordinary-fields-${scale}`,
    family: "ordinary-fields",
    scale,
    source,
    expected: scale * 2 + 6,
    dimensions: { fieldCount: scale, topologyCopies: 1 },
    explicitBorrow: false,
  };
};

const topologyDefinition = (index: number): string => `obj DtoRecord${index} {
  field_0: i32,
  field_1: i32,
  field_2: i32,
  field_3: i32,
  nested: GenericBox<i32>
}

obj DtoRecordChoice${index} { value: DtoRecord${index} }
obj DtoFallbackChoice${index} { value: i32 }
type DtoChoice${index} = DtoRecordChoice${index} | DtoFallbackChoice${index}

impl DtoScore for DtoRecord${index}
  fn score(self) -> i32
    self.field_0 + self.nested.value

fn projected_mutation_${index}(~value: DtoRecord${index}) -> void
  value.nested.value = value.nested.value + 1

fn choice_score_${index}(value: DtoChoice${index}) -> i32
  match(value)
    DtoRecordChoice${index} { value: record }: dynamic_score(record)
    DtoFallbackChoice${index} { value }: value

fn run_${index}() -> i32
  let ~value = DtoRecord${index} {
    field_0: ${index},
    field_1: ${index + 1},
    field_2: ${index + 2},
    field_3: ${index + 3},
    nested: GenericBox<i32> { value: ${index + 1} }
  }
  projected_mutation_${index}(~value)
  choice_score_${index}(DtoRecordChoice${index} { value })
`;

const ordinaryTopologyScenario = (scale: number): Scenario => {
  const source = `#!no_prelude
trait DtoScore
  fn score(self) -> i32

obj GenericBox<T> { value: T }

fn dynamic_score(value: DtoScore) -> i32
  value.score()

${lines(scale, topologyDefinition)}

pub fn main() -> i32
  ${Array.from({ length: scale }, (_, index) => `run_${index}()`).join(" + ")}
`;
  return {
    name: `ordinary-topology-${scale}`,
    family: "ordinary-topology",
    scale,
    source,
    expected: scale * scale + scale,
    dimensions: { fieldCount: 4, topologyCopies: scale },
    explicitBorrow: false,
  };
};

const borrowCallsScenario = (scale: number): Scenario => {
  const callables = lines(
    scale,
    (index) => `fn read_${index}(value: Borrow<BorrowNode>) -> i32
  ${index === 0 ? "value.value" : `read_${index - 1}(value) + 1`}
`,
  );
  const source = `use std::shared_cell::SharedCell

obj BorrowNode { value: i32 }

${callables}
pub fn main() -> i32
  let cell = SharedCell(BorrowNode { value: 7 })
  cell.with((value) => read_${scale - 1}(value))
`;
  return {
    name: `borrow-calls-${scale}`,
    family: "borrow-calls",
    scale,
    source,
    expected: scale + 6,
    dimensions: {
      borrowAwareCallables: scale,
      projectionDepth: 1,
      nestedCallbacks: 1,
    },
    explicitBorrow: true,
  };
};

const borrowDepthScenario = (scale: number): Scenario => {
  const layers = lines(
    scale,
    (index) =>
      `obj BorrowLayer${index} { child: ${index === 0 ? "BorrowLeaf" : `BorrowLayer${index - 1}`} }`,
  );
  const projection = `${lines(scale, () => ".child")}.value`.replaceAll(
    "\n",
    "",
  );
  let value = "BorrowLeaf { value: 11 }";
  for (let index = 0; index < scale; index += 1) {
    value = `BorrowLayer${index} { child: ${value} }`;
  }
  const source = `use std::shared_cell::SharedCell

obj BorrowLeaf { value: i32 }
${layers}

fn read_depth(value: Borrow<BorrowLayer${scale - 1}>) -> i32
  value${projection}

pub fn main() -> i32
  let cell = SharedCell(${value})
  cell.with((value) => read_depth(value))
`;
  return {
    name: `borrow-depth-${scale}`,
    family: "borrow-depth",
    scale,
    source,
    expected: 11,
    dimensions: {
      borrowAwareCallables: 1,
      projectionDepth: scale + 1,
      nestedCallbacks: 1,
    },
    explicitBorrow: true,
  };
};

const nestedCallbackBody = (scale: number): string => {
  const callbackValue = (index: number, depth: number): string[] => {
    const indent = "  ".repeat(depth);
    if (index === scale - 1) return [`${indent}value_${index}.value`];
    return [
      `${indent}let nested_${index} = cell_0.with((value_${index + 1}) =>`,
      ...callbackValue(index + 1, depth + 1),
      `${indent})`,
      `${indent}nested_${index} + value_${index}.value`,
    ];
  };
  return [`  cell_0.with((value_0) =>`, ...callbackValue(0, 2), `  )`].join(
    "\n",
  );
};

const borrowCallbacksScenario = (scale: number): Scenario => {
  const source = `use std::shared_cell::SharedCell

obj BorrowNode { value: i32 }

pub fn main() -> i32
  let cell_0 = SharedCell(BorrowNode { value: 1 })
${nestedCallbackBody(scale)}
`;
  return {
    name: `borrow-callbacks-${scale}`,
    family: "borrow-callbacks",
    scale,
    source,
    expected: scale,
    dimensions: {
      borrowAwareCallables: 1,
      projectionDepth: 1,
      nestedCallbacks: scale,
    },
    explicitBorrow: true,
  };
};

const directMutationFunctions = (scale: number): string =>
  lines(
    scale,
    (index) => `fn direct_${index}(~value: MutationBox) -> void
  ${index > 0 ? `direct_${index - 1}(~value)\n  ` : ""}value.value = value.value + 1
`,
  );

const sccMutationFunctions = (scale: number): string =>
  lines(
    scale,
    (index) => `fn cycle_${index}(~value: MutationBox, remaining: i32) -> void
  if remaining <= 0:
    value.value = value.value + 1
  else:
    cycle_${(index + 1) % scale}(~value, remaining - 1)
`,
  );

const mutationMixedScenario = (scale: number): Scenario => {
  const source = `#!no_prelude
use std::array::Array

obj MutationBox { value: i32 }

trait MutationStep
  fn step(~self) : () -> void

impl MutationStep for MutationBox
  fn step(~self) : () -> void
    self.value = self.value + 1

fn dynamic_step(~value: MutationStep) : () -> void
  value.step()

fn callback_step(value: i32) -> i32
  value + 1

fn apply_callback(
  value: i32,
  callback: fn(item: i32) : () -> i32
) : (open) -> i32
  callback(value)

fn apply_reader(callback: fn() : () -> i32) : (open) -> i32
  callback()

fn callback_and_ambient_sites(value: i32, ambient: MutationBox) : (open) -> i32
${lines(scale, (index) => `  let callback_${index} = apply_callback(value, callback_step)`)}
${lines(scale, (index) => `  let observed_${index} = apply_reader(() => ambient.value)`)}
  ${Array.from({ length: scale }, (_, index) => `callback_${index}`).join(" + ")} + ${Array.from({ length: scale }, (_, index) => `observed_${index}`).join(" + ")}

fn mutate_pair(~left: MutationBox, ~right: MutationBox) -> void
  left.value = left.value + 1
  right.value = right.value + 2

fn guarded_pair(
  ~values: Array<MutationBox>,
  left: i32,
  right: i32
) -> void
  mutate_pair(~values.at(left), ~values.at(right))

${directMutationFunctions(scale)}
${sccMutationFunctions(scale)}
pub fn main() -> i32
  let ~box = MutationBox { value: 1 }
  direct_${scale - 1}(~box)
${lines(scale, () => "  dynamic_step(~box)")}
  cycle_0(~box, ${scale})

  let ~values = Array<MutationBox>::with_capacity(2)
  values.push(MutationBox { value: 3 })
  values.push(MutationBox { value: 5 })
${lines(scale, () => "  guarded_pair(~values, 0, 1)")}

  box.value + values.at(0).value + values.at(1).value
`;
  return {
    name: `mutation-mixed-${scale}`,
    family: "mutation-mixed",
    scale,
    source,
    expected: 10 + 5 * scale,
    dimensions: {
      directCallDepth: scale,
      dynamicCallSites: scale,
      callbackCallSites: scale,
      ambientReadSites: scale,
      identityGuardSites: scale,
      sccMembers: scale,
    },
    explicitBorrow: false,
  };
};

const generateScenarios = (sizes: readonly number[]): Scenario[] =>
  sizes.flatMap((size) => [
    ordinaryFieldsScenario(size),
    ordinaryTopologyScenario(size),
    borrowCallsScenario(size),
    borrowDepthScenario(size),
    borrowCallbacksScenario(size),
    mutationMixedScenario(size),
  ]);

const median = (values: readonly number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
};

const distribution = (values: readonly number[]): Distribution => {
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 0) {
    throw new Error("cannot summarize an empty distribution");
  }
  return {
    values: [...values],
    min: sorted[0]!,
    median: median(sorted),
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1]!,
    max: sorted.at(-1)!,
  };
};

const medianRecord = (
  records: readonly Readonly<Record<string, number>>[],
): Record<string, number> =>
  Object.fromEntries(
    Array.from(new Set(records.flatMap((record) => Object.keys(record))))
      .sort()
      .map((key) => [key, median(records.map((record) => record[key] ?? 0))]),
  );

const metricValue = (
  record: Readonly<Record<string, number>>,
  candidates: readonly string[],
): number | null => {
  const match = candidates.find((candidate) => record[candidate] !== undefined);
  return match === undefined ? null : record[match]!;
};

const requiredMetrics = ({
  compileMedianMs,
  peakRssMedianBytes,
  wasmBytes,
  runtimeMedianMs,
  phases,
  counters,
}: {
  compileMedianMs: number;
  peakRssMedianBytes: number;
  wasmBytes: number | null;
  runtimeMedianMs: number | null;
  phases: Record<string, number>;
  counters: Record<string, number>;
}): RequiredMetrics => ({
  totalCompilationMs: compileMedianMs,
  totalSemanticMs: metricValue(phases, [
    "analyzeModules",
    "analyzeSemantics",
    "analyzeProgram",
    "semantics",
  ]),
  ordinaryMutationAnalysisMs: metricValue(phases, [
    "analyzeBorrowing.ordinaryMutation",
    "analyzeBorrowing.ordinaryMutationSummaries",
    "borrowing.ordinary.solve",
  ]),
  explicitBorrowAnalysisMs: metricValue(phases, [
    "analyzeBorrowing.explicitBorrows",
    "analyzeBorrowing.explicitBorrow",
    "borrowing.explicit.solve",
  ]),
  callableCount: metricValue(counters, [
    "borrowing.ordinary.callables",
    "borrowing.body.totalCallables",
  ]),
  callEdgeCount: metricValue(counters, ["borrowing.ordinary.callEdges"]),
  ordinarySummaryEvaluations: metricValue(counters, [
    "borrowing.ordinary.summaryEvaluations",
  ]),
  ordinarySccReevaluations: metricValue(counters, [
    "borrowing.ordinary.sccReevaluations",
  ]),
  explicitBorrowFactCount: metricValue(counters, [
    "borrowing.explicit.provenanceFacts",
    "borrowing.explicit.factCount",
    "borrowing.explicitBorrowFacts",
  ]),
  projectionFamilyCount: metricValue(counters, [
    "borrowing.ordinary.projectionFamilies",
    "borrowing.projectionFamilies",
  ]),
  wideningCount: metricValue(counters, [
    "borrowing.ordinary.widenings",
    "borrowing.flowWidenings",
  ]),
  retainedSummaryBytes: metricValue(counters, [
    "borrowing.ordinary.retainedSummaryBytes",
    "borrowing.contract.retainedBytes",
  ]),
  peakRssBytes: peakRssMedianBytes,
  wasmBytes,
  runtimeMedianMs,
});

const diagnosticSignature = (diagnostic: Diagnostic): string =>
  `${diagnostic.code ?? "unknown"}:${diagnostic.message ?? ""}`;

const summarizeRow = ({
  repository,
  scenario,
  mode,
  samples,
}: {
  repository: Repository;
  scenario: Scenario;
  mode: OptimizationMode;
  samples: Sample[];
}): ResultRow => {
  const successful = samples.filter((sample) => sample.compileSuccess);
  const hashes = new Set(successful.map((sample) => sample.wasmSha256));
  const sizes = new Set(successful.map((sample) => sample.wasmBytes));
  if (hashes.size > 1 || sizes.size > 1) {
    throw new Error(
      `${repository.label}/${scenario.name}/${mode} emitted nondeterministic Wasm`,
    );
  }
  const phases = medianRecord(samples.map((sample) => sample.phasesMs));
  const counters = medianRecord(samples.map((sample) => sample.counters));
  const runtimeValues = samples.flatMap((sample) => sample.runtimeSamplesMs);
  const compileMs = distribution(samples.map((sample) => sample.durationMs));
  const primingDurations = samples.flatMap((sample) =>
    sample.primingDurationMs === null ? [] : [sample.primingDurationMs],
  );
  const isWarmSourceEdit = primingDurations.length > 0;
  const canonicalMeasuredSource = isWarmSourceEdit
    ? sourceAfterWarmEdit(scenario.source)
    : scenario.source;
  const measuredSource = renderSourceForDialect(
    canonicalMeasuredSource,
    repository.borrowSyntaxDialect,
  );
  const primingSource = renderSourceForDialect(
    scenario.source,
    repository.borrowSyntaxDialect,
  );
  const peakRss = distribution(samples.map((sample) => sample.peakRssBytes));
  const runtime = runtimeValues.length > 0 ? distribution(runtimeValues) : null;
  const metrics = requiredMetrics({
    compileMedianMs: compileMs.median,
    peakRssMedianBytes: peakRss.median,
    wasmBytes: successful[0]?.wasmBytes ?? null,
    runtimeMedianMs: runtime?.median ?? null,
    phases,
    counters,
  });
  return {
    repository: repository.label,
    revision: repository.revision,
    scenario: scenario.name,
    family: scenario.family,
    scale: scenario.scale,
    dimensions: scenario.dimensions,
    explicitBorrow: scenario.explicitBorrow,
    compileKind: isWarmSourceEdit ? "warm-source-only-edit" : "cold",
    sourceDialect: repository.borrowSyntaxDialect,
    canonicalSourceSha256: createHash("sha256")
      .update(canonicalMeasuredSource)
      .digest("hex"),
    canonicalPrimingSourceSha256: isWarmSourceEdit
      ? createHash("sha256").update(scenario.source).digest("hex")
      : null,
    sourceSha256: createHash("sha256")
      .update(measuredSource.source)
      .digest("hex"),
    primingSourceSha256: isWarmSourceEdit
      ? createHash("sha256").update(primingSource.source).digest("hex")
      : null,
    borrowSyntaxReplacementCount: measuredSource.borrowSyntaxReplacementCount,
    sourceBytes: Buffer.byteLength(measuredSource.source),
    sourceLines: measuredSource.source.split("\n").length,
    mode,
    compileSuccessRate: successful.length / samples.length,
    diagnosticSignatures: Array.from(
      new Set(
        samples.flatMap((sample) =>
          sample.diagnostics.map(diagnosticSignature),
        ),
      ),
    ).sort(),
    compileMs,
    primingCompileMs:
      primingDurations.length > 0 ? distribution(primingDurations) : null,
    peakHeapUsedBytes: distribution(
      samples.map((sample) => sample.peakHeapUsedBytes),
    ),
    peakRssBytes: peakRss,
    processMaxRssBytes: distribution(
      samples.map((sample) => sample.processMaxRssBytes),
    ),
    processMaxRssGrowthBytes: distribution(
      samples.map((sample) => sample.processMaxRssGrowthBytes),
    ),
    wasmBytes: successful[0]?.wasmBytes ?? null,
    wasmSha256: successful[0]?.wasmSha256 ?? null,
    runtimeMs: runtime,
    phaseMediansMs: phases,
    counterMedians: counters,
    optimizerDispositionCounters: Object.fromEntries(
      Object.entries(counters).filter(
        ([name]) =>
          /^(?:optimize|optimization|codegen|borrowing\.identity_guard)\./.test(
            name,
          ) &&
          /(?:accept|fallback|reject|reason|budget|exact|request|emit|disjoint|created|compiled|reused|bailout|applied|pairs)/i.test(
            name,
          ),
      ),
    ),
    requiredMetrics: metrics,
    missingRequiredMetrics: Object.entries(metrics)
      .filter(([, value]) => value === null)
      .map(([name]) => name),
    samples,
  };
};

const ratio = (
  candidate: number | null,
  baseline: number | null,
): number | null =>
  candidate === null || baseline === null || baseline === 0
    ? null
    : candidate / baseline;

const ratioRecord = (
  candidate: Record<string, number>,
  baseline: Record<string, number>,
): Record<string, number | null> =>
  Object.fromEntries(
    Array.from(new Set([...Object.keys(baseline), ...Object.keys(candidate)]))
      .sort()
      .map((name) => [
        name,
        ratio(candidate[name] ?? null, baseline[name] ?? null),
      ]),
  );

const comparisonsFor = (
  rows: readonly ResultRow[],
  repositories: readonly Repository[],
) => {
  const baselineRepository = repositories[0];
  if (!baselineRepository || repositories.length < 2) return [];
  return repositories.slice(1).flatMap((candidateRepository) =>
    rows
      .filter((row) => row.repository === candidateRepository.label)
      .map((candidate) => {
        const baseline = rows.find(
          (row) =>
            row.repository === baselineRepository.label &&
            row.scenario === candidate.scenario &&
            row.mode === candidate.mode,
        );
        if (!baseline) {
          throw new Error(
            `missing baseline for ${candidate.scenario}/${candidate.mode}`,
          );
        }
        return {
          baseline: baseline.repository,
          candidate: candidate.repository,
          scenario: candidate.scenario,
          family: candidate.family,
          scale: candidate.scale,
          mode: candidate.mode,
          ratios: {
            compileMedianMs: ratio(
              candidate.compileMs.median,
              baseline.compileMs.median,
            ),
            peakRssMedianBytes: ratio(
              candidate.peakRssBytes.median,
              baseline.peakRssBytes.median,
            ),
            processMaxRssGrowthMedianBytes: ratio(
              candidate.processMaxRssGrowthBytes.median,
              baseline.processMaxRssGrowthBytes.median,
            ),
            wasmBytes: ratio(candidate.wasmBytes, baseline.wasmBytes),
            runtimeMedianMs: ratio(
              candidate.runtimeMs?.median ?? null,
              baseline.runtimeMs?.median ?? null,
            ),
          },
          requiredMetricRatios: Object.fromEntries(
            Object.keys(candidate.requiredMetrics).map((name) => [
              name,
              ratio(
                candidate.requiredMetrics[name as keyof RequiredMetrics],
                baseline.requiredMetrics[name as keyof RequiredMetrics],
              ),
            ]),
          ),
          phaseRatios: ratioRecord(
            candidate.phaseMediansMs,
            baseline.phaseMediansMs,
          ),
          counterRatios: ratioRecord(
            candidate.counterMedians,
            baseline.counterMedians,
          ),
        };
      }),
  );
};

const scalingSeriesFor = (rows: readonly ResultRow[]) => {
  const groups = new Map<string, ResultRow[]>();
  rows.forEach((row) => {
    const key = `${row.repository}\0${row.mode}\0${row.family}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  });
  return Array.from(groups.values()).map((group) => {
    const ordered = [...group].sort((left, right) => left.scale - right.scale);
    const first = ordered[0]!;
    return {
      repository: first.repository,
      revision: first.revision,
      mode: first.mode,
      family: first.family,
      points: ordered.map((row) => ({
        scale: row.scale,
        dimensions: row.dimensions,
        compileMedianMs: row.compileMs.median,
        peakRssMedianBytes: row.peakRssBytes.median,
        requiredMetrics: row.requiredMetrics,
      })),
      adjacentGrowth: ordered.slice(1).map((row, index) => {
        const previous = ordered[index]!;
        return {
          fromScale: previous.scale,
          toScale: row.scale,
          inputRatio: row.scale / previous.scale,
          compileRatio: row.compileMs.median / previous.compileMs.median,
          rssRatio: row.peakRssBytes.median / previous.peakRssBytes.median,
          callEdgeRatio: ratio(
            row.requiredMetrics.callEdgeCount,
            previous.requiredMetrics.callEdgeCount,
          ),
          summaryEvaluationRatio: ratio(
            row.requiredMetrics.ordinarySummaryEvaluations,
            previous.requiredMetrics.ordinarySummaryEvaluations,
          ),
          retainedSummaryBytesRatio: ratio(
            row.requiredMetrics.retainedSummaryBytes,
            previous.requiredMetrics.retainedSummaryBytes,
          ),
          explicitBorrowFactRatio: ratio(
            row.requiredMetrics.explicitBorrowFactCount,
            previous.requiredMetrics.explicitBorrowFactCount,
          ),
        };
      }),
      exactStructuralObservations: {
        retainedSummaryBytesConstant:
          first.family === "ordinary-fields" &&
          ordered.every(
            (row) => row.requiredMetrics.retainedSummaryBytes !== null,
          )
            ? new Set(
                ordered.map((row) => row.requiredMetrics.retainedSummaryBytes),
              ).size === 1
            : null,
        ordinaryProjectionFamiliesZero:
          first.family.startsWith("ordinary-") &&
          ordered.every(
            (row) => row.requiredMetrics.projectionFamilyCount !== null,
          )
            ? ordered.every(
                (row) => row.requiredMetrics.projectionFamilyCount === 0,
              )
            : null,
        ordinaryWideningsZero:
          first.family.startsWith("ordinary-") &&
          ordered.every((row) => row.requiredMetrics.wideningCount !== null)
            ? ordered.every((row) => row.requiredMetrics.wideningCount === 0)
            : null,
        noBorrowExplicitFactsZero:
          !first.explicitBorrow &&
          ordered.every(
            (row) => row.requiredMetrics.explicitBorrowFactCount !== null,
          )
            ? ordered.every(
                (row) => row.requiredMetrics.explicitBorrowFactCount === 0,
              )
            : null,
      },
    };
  });
};

const runWorker = async (config: WorkerConfig): Promise<WorkerResult> => {
  const sdk = (await import(
    pathToFileURL(path.join(config.repository, "packages/sdk/src/index.ts"))
      .href
  )) as SdkModule;
  const summaries: CompilerPerfSummary[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]): void => {
    const message = args.map(String).join(" ");
    const prefix = "[voyd:compiler:perf] ";
    if (message.startsWith(prefix)) {
      summaries.push(
        JSON.parse(message.slice(prefix.length)) as CompilerPerfSummary,
      );
      return;
    }
    originalError(...args);
  };

  let maxRssBeforeBytes = process.resourceUsage().maxRSS * 1024;
  let peakHeapUsedBytes = process.memoryUsage().heapUsed;
  let peakRssBytes = process.memoryUsage().rss;
  const memoryPoll = setInterval(() => {
    const usage = process.memoryUsage();
    peakHeapUsedBytes = Math.max(peakHeapUsedBytes, usage.heapUsed);
    peakRssBytes = Math.max(peakRssBytes, usage.rss);
  }, 5);
  try {
    const canonicalPrimingSource = config.scenario.source;
    const primingSource = renderSourceForDialect(
      canonicalPrimingSource,
      config.borrowSyntaxDialect,
    ).source;
    const compiler = sdk.createSdk({
      compilerCache: config.warmSourceEdit ? "memory" : "none",
    });
    const compile = (source: string) =>
      compiler.compile({
        entryPath: `${config.scenario.name}.voyd`,
        source,
        optimize: config.mode !== "none",
        optimizationLevel: config.mode,
        boundaryExports: false,
        effectsHostBoundary: "off",
      });
    let primingDurationMs: number | null = null;
    if (config.warmSourceEdit) {
      const primingStartedAt = performance.now();
      const primingResult = await compile(primingSource);
      primingDurationMs = performance.now() - primingStartedAt;
      if (!primingResult.success) {
        throw new Error(
          `${config.scenario.name} priming compile failed:\n${primingResult.diagnostics
            .map((diagnostic) => diagnosticSignature(diagnostic))
            .join("\n")}`,
        );
      }
      summaries.length = 0;
      maxRssBeforeBytes = process.resourceUsage().maxRSS * 1024;
      const usage = process.memoryUsage();
      peakHeapUsedBytes = usage.heapUsed;
      peakRssBytes = usage.rss;
    }
    const canonicalMeasuredSource = config.warmSourceEdit
      ? sourceAfterWarmEdit(canonicalPrimingSource)
      : canonicalPrimingSource;
    const measuredSource = renderSourceForDialect(
      canonicalMeasuredSource,
      config.borrowSyntaxDialect,
    ).source;
    const startedAt = performance.now();
    const result = await compile(measuredSource);
    const durationMs = performance.now() - startedAt;
    const usage = process.memoryUsage();
    peakHeapUsedBytes = Math.max(peakHeapUsedBytes, usage.heapUsed);
    peakRssBytes = Math.max(peakRssBytes, usage.rss);
    const perf = summaries.at(-1);
    if (perf?.overlapped) {
      throw new Error(
        `${config.scenario.name} emitted an overlapped perf session`,
      );
    }
    const processMaxRssBytes = process.resourceUsage().maxRSS * 1024;
    const wasm = result.success ? result.wasm : undefined;
    if (wasm && !WebAssembly.validate(wasm as BufferSource)) {
      throw new Error(`${config.scenario.name} emitted invalid WebAssembly`);
    }

    const runtimeSamplesMs: number[] = [];
    if (wasm && config.runtimeSamples > 0) {
      const hostModule = (await import(
        pathToFileURL(
          path.join(config.repository, "packages/sdk/src/js-host.ts"),
        ).href
      )) as HostModule;
      const host = await hostModule.createVoydHost({ wasm });
      const warmup = await host.runPure<number>("main");
      if (warmup !== config.scenario.expected) {
        throw new Error(
          `${config.scenario.name} returned ${warmup}; expected ${config.scenario.expected}`,
        );
      }
      for (let sample = 0; sample < config.runtimeSamples; sample += 1) {
        let elapsedMs = 0;
        let iterations = 0;
        do {
          const runStartedAt = performance.now();
          const value = await host.runPure<number>("main");
          elapsedMs += performance.now() - runStartedAt;
          iterations += 1;
          if (value !== config.scenario.expected) {
            throw new Error(
              `${config.scenario.name} returned ${value}; expected ${config.scenario.expected}`,
            );
          }
        } while (elapsedMs < config.runtimeSampleMinMs);
        runtimeSamplesMs.push(elapsedMs / iterations);
      }
    }

    return {
      sample: {
        compileSuccess: result.success,
        primingDurationMs,
        durationMs,
        peakHeapUsedBytes,
        peakRssBytes,
        processMaxRssBytes,
        processMaxRssGrowthBytes: Math.max(
          0,
          processMaxRssBytes - maxRssBeforeBytes,
        ),
        phasesMs: perf?.phasesMs ?? {},
        counters: perf?.counters ?? {},
        wasmBytes: wasm?.byteLength ?? null,
        wasmSha256: wasm
          ? createHash("sha256").update(wasm).digest("hex")
          : null,
        diagnostics: [...(result.diagnostics ?? [])],
        runtimeSamplesMs,
      },
    };
  } finally {
    clearInterval(memoryPoll);
    console.error = originalError;
  }
};

const runWorkerProcess = ({
  repository,
  borrowSyntaxDialect,
  scenario,
  mode,
  runtimeSamples,
  runtimeSampleMinMs,
  warmSourceEdit,
}: WorkerConfig): WorkerResult => {
  const config: WorkerConfig = {
    repository,
    borrowSyntaxDialect,
    scenario,
    mode,
    runtimeSamples,
    runtimeSampleMinMs,
    warmSourceEdit,
  };
  const scriptPath = fileURLToPath(import.meta.url);
  const child = spawnSync(
    process.execPath,
    [
      "--conditions=development",
      "--import",
      "tsx",
      scriptPath,
      "--worker-config",
      Buffer.from(JSON.stringify(config)).toString("base64url"),
    ],
    {
      cwd: repository,
      encoding: "utf8",
      env: { ...process.env, VOYD_COMPILER_PERF: "1" },
      maxBuffer: 50 * 1024 * 1024,
    },
  );
  if (child.status !== 0) {
    throw new Error(
      `${scenario.name}/${mode} failed in ${repository}:\n${child.stderr || child.stdout}`,
    );
  }
  return JSON.parse(child.stdout) as WorkerResult;
};

const parseControllerOptions = (): ControllerOptions => {
  const sizes = parseSizes();
  const generated = generateScenarios(sizes);
  const requestedNames = valuesAfter("--scenario");
  const scenarios =
    requestedNames.length > 0
      ? requestedNames.map((name) => {
          const scenario = generated.find(
            (candidate) => candidate.name === name,
          );
          if (!scenario) {
            throw new Error(
              `unknown scenario ${name}; use --list with the same --sizes`,
            );
          }
          return scenario;
        })
      : generated.filter((scenario) =>
          parseFamilies().includes(scenario.family),
        );
  if (
    requestedNames.length === 0 &&
    scenarios.some((scenario) => scenario.family.startsWith("ordinary-")) &&
    sizes.length < 4
  ) {
    throw new Error(
      "ordinary DTO acceptance runs require at least four --sizes growth points",
    );
  }
  return {
    repositories: parseRepositories(),
    scenarios,
    modes: parseModes(),
    sampleCount: parseInteger({ name: "--samples", fallback: 5, minimum: 1 }),
    warmupCount: parseInteger({ name: "--warmups", fallback: 1, minimum: 0 }),
    runtimeSamples: parseInteger({
      name: "--runtime-samples",
      fallback: 0,
      minimum: 0,
    }),
    runtimeSampleMinMs: parseNumber({
      name: "--runtime-min-ms",
      fallback: 100,
      minimum: 0,
    }),
    failOnDiagnostics: process.argv.includes("--fail-on-diagnostics"),
    warmSourceEdit: process.argv.includes("--warm-source-edit"),
    ...(valueAfter("--output")
      ? { outputPath: path.resolve(valueAfter("--output")!) }
      : {}),
  };
};

const runController = (options: ControllerOptions): void => {
  const samples = new Map<string, Sample[]>();
  const keyFor = (label: string, scenario: string, mode: string): string =>
    `${label}\0${scenario}\0${mode}`;

  for (const scenario of options.scenarios) {
    for (const mode of options.modes) {
      for (let warmup = 0; warmup < options.warmupCount; warmup += 1) {
        for (const repository of options.repositories) {
          runWorkerProcess({
            repository: repository.repository,
            borrowSyntaxDialect: repository.borrowSyntaxDialect,
            scenario,
            mode,
            runtimeSamples: 0,
            runtimeSampleMinMs: options.runtimeSampleMinMs,
            warmSourceEdit: options.warmSourceEdit,
          });
        }
      }
      for (let sample = 0; sample < options.sampleCount; sample += 1) {
        const repositories =
          sample % 2 === 0
            ? options.repositories
            : [...options.repositories].reverse();
        for (const repository of repositories) {
          const result = runWorkerProcess({
            repository: repository.repository,
            borrowSyntaxDialect: repository.borrowSyntaxDialect,
            scenario,
            mode,
            runtimeSamples:
              mode === "release" && sample === options.sampleCount - 1
                ? options.runtimeSamples
                : 0,
            runtimeSampleMinMs: options.runtimeSampleMinMs,
            warmSourceEdit: options.warmSourceEdit,
          });
          if (options.failOnDiagnostics && !result.sample.compileSuccess) {
            throw new Error(
              `${repository.label}/${scenario.name}/${mode} produced diagnostics:\n${result.sample.diagnostics
                .map(diagnosticSignature)
                .join("\n")}`,
            );
          }
          const key = keyFor(repository.label, scenario.name, mode);
          samples.set(key, [...(samples.get(key) ?? []), result.sample]);
        }
      }
    }
  }

  const rows = options.repositories.flatMap((repository) =>
    options.scenarios.flatMap((scenario) =>
      options.modes.map((mode) =>
        summarizeRow({
          repository,
          scenario,
          mode,
          samples: samples.get(keyFor(repository.label, scenario.name, mode))!,
        }),
      ),
    ),
  );
  const borrowSyntaxDialects = Array.from(
    new Set(
      options.repositories.map(
        ({ borrowSyntaxDialect }) => borrowSyntaxDialect,
      ),
    ),
  ).sort();
  const sourceManifest = options.scenarios.map((scenario) => ({
    scenario: scenario.name,
    canonicalDialect: "scoped-generic" as const,
    canonicalSourceSha256: createHash("sha256")
      .update(scenario.source)
      .digest("hex"),
    renderings: Object.fromEntries(
      borrowSyntaxDialects.map((dialect) => {
        const rendered = renderSourceForDialect(scenario.source, dialect);
        return [
          dialect,
          {
            sourceSha256: createHash("sha256")
              .update(rendered.source)
              .digest("hex"),
            sourceBytes: Buffer.byteLength(rendered.source),
            sourceLines: rendered.source.split("\n").length,
            borrowSyntaxReplacementCount: rendered.borrowSyntaxReplacementCount,
          },
        ];
      }),
    ),
  }));
  const report = {
    schemaVersion: 3,
    generatedAt: new Date().toISOString(),
    benchmark: "V-500 scoped explicit borrows",
    invocation: {
      cwd: process.cwd(),
      arguments: process.argv.slice(2),
    },
    environment: {
      node: process.version,
      npmUserAgent: process.env.npm_config_user_agent ?? null,
      platform: process.platform,
      architecture: process.arch,
      osRelease: release(),
      logicalCpuCount: cpus().length,
      cpuModel: cpus()[0]?.model ?? "unknown",
      totalMemoryBytes: totalmem(),
    },
    repositories: options.repositories,
    sourceManifest,
    methodology: {
      sampleCountPerRepositoryScenarioAndMode: options.sampleCount,
      discardedWarmupsPerRepositoryScenarioAndMode: options.warmupCount,
      freshNodeProcessPerCompile: !options.warmSourceEdit,
      freshNodeProcessPerMeasuredSample: true,
      compilesPerWorker: options.warmSourceEdit ? 2 : 1,
      alternatingRepositoryOrder: options.repositories.length > 1,
      sameCanonicalScenarioAcrossRepositories: true,
      sameRenderedSourceAcrossRepositories:
        borrowSyntaxDialects.length === 1 ||
        options.scenarios.every(({ explicitBorrow }) => !explicitBorrow),
      borrowSyntaxAdapter: {
        version: 1,
        canonicalDialect: "scoped-generic",
        supportedRenderings: borrowSyntaxDialects,
        transformation: "Borrow<T> -> borrow T",
        scope: "standalone generated callable-input type annotations only",
        addsContractsOrCapabilities: false,
      },
      compileKind: options.warmSourceEdit ? "warm-source-only-edit" : "cold",
      compilerCache: options.warmSourceEdit ? "memory" : "none",
      sourceOnlyEdit: options.warmSourceEdit
        ? "append one comment while retaining the entry path and SDK instance"
        : null,
      runtimeSamplesOnLastReleaseArtifact: options.runtimeSamples,
      runtimeSampleMinimumMs: options.runtimeSampleMinMs,
      runtimeWarmupCalls: options.runtimeSamples > 0 ? 1 : 0,
      compilerPerfEnvironment: "VOYD_COMPILER_PERF=1",
    },
    rows,
    scalingSeries: scalingSeriesFor(rows),
    sameMachineComparisons: comparisonsFor(rows, options.repositories),
    acceptanceWorkloads: ACCEPTANCE_WORKLOADS,
  };
  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (options.outputPath) writeFileSync(options.outputPath, output);
  process.stdout.write(output);
};

const workerConfig = valueAfter("--worker-config");
if (workerConfig) {
  const config = JSON.parse(
    Buffer.from(workerConfig, "base64url").toString("utf8"),
  ) as WorkerConfig;
  process.stdout.write(`${JSON.stringify(await runWorker(config))}\n`);
} else if (process.argv.includes("--help")) {
  process.stdout.write(HELP);
} else {
  const sizes = parseSizes();
  if (process.argv.includes("--list-workloads")) {
    process.stdout.write(`${JSON.stringify(ACCEPTANCE_WORKLOADS, null, 2)}\n`);
  } else if (process.argv.includes("--list")) {
    process.stdout.write(
      `${JSON.stringify(
        generateScenarios(sizes).map(
          ({ name, family, scale, dimensions, explicitBorrow, expected }) => ({
            name,
            family,
            scale,
            dimensions,
            explicitBorrow,
            expected,
          }),
        ),
        null,
        2,
      )}\n`,
    );
  } else {
    runController(parseControllerOptions());
  }
}
