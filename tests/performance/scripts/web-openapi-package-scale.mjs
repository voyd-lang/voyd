import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { cpus, release, totalmem } from "node:os";
import path, { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PERF_PREFIX = "[voyd:compiler:perf] ";
const DEFAULT_TIMEOUT_MS = 900_000;
const CPU_PROFILE_INTERVAL_US = 10_000;
const WORKER_REPORT_FD = 3;
const WORKER_KILL_GRACE_MS = 5_000;
const ENTRY_RELATIVE_PATH =
  "packages/web/src/openapi/openapi_app.test.voyd";
const V500_COUNTER_SCHEMA_RELATIVE_PATH =
  "packages/compiler/src/perf-counter-schema.ts";
const V500_REQUIRED_PHASES = [
  "total",
  "analyzeBorrowing",
  "analyzeBorrowing.finiteLocal",
  "analyzeBorrowing.ordinaryMutation",
  "analyzeBorrowing.explicitBorrow",
];
// Counters shared by every revision supported by this historical comparison.
// Revision-specific zero-presence counters come from that checkout's declared
// schema, so adding a counter does not make older baselines unmeasurable.
const STABLE_REQUIRED_ANALYSIS_COUNTERS = [
  "borrowing.ordinary.callables",
  "borrowing.ordinary.callEdges",
  "borrowing.ordinary.summaryEvaluations",
  "borrowing.ordinary.sccReevaluations",
  "borrowing.ordinary.retainedSummaryBytes",
  "borrowing.ordinary.projectionFamilies",
  "borrowing.ordinary.widenings",
  "borrowing.explicitBorrowFacts",
];
const SOURCE_INPUTS = [
  "packages/compiler/src",
  "packages/sdk/src",
  "packages/lib/src",
  "packages/std/src",
  "packages/web/src",
];
const DEPENDENCY_INPUTS = [
  "package.json",
  "package-lock.json",
  "packages/compiler/package.json",
  "packages/sdk/package.json",
  "packages/lib/package.json",
  "packages/std/package.json",
  "packages/web/package.json",
];
const WORKSPACE_PACKAGE_RESOLUTIONS = [
  ["@voyd-lang/compiler", "compiler"],
  ["@voyd-lang/js-host", "js-host"],
  ["@voyd-lang/lib", "lib"],
  ["@voyd-lang/package-adapter", "package-adapter"],
  ["@voyd-lang/std", "std"],
];

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "../../..");

const HELP = `Web OpenAPI package-scale compiler benchmark

Usage:
  npm run bench:web-openapi -- [options]

Options:
  --repo LABEL=/absolute/path  Checkout to measure; repeat for a comparison.
                              Defaults to current=<script checkout>.
  --samples N                 Retained fresh-process samples. Default: 1.
  --warmups N                 Discarded fresh-process warmups. Default: 0.
  --compiler-cache MODE       none or memory. Default: none.
  --compile-count N           Compiles per child process. Default: 1.
  --timeout-ms N              Timeout for each child. Default: 900000.
  --cpu-profile-dir PATH      Write bounded 10 ms Node CPU profiles.
  --require-clean             Reject a dirty measured checkout.
  --output PATH               Also write the exact JSON report to PATH.
  --help                      Print this help.

Use --warmups 1 --samples 7 with compiler-cache none and compile-count 1 for
V-500 cold base/head evidence. Each retained sample has a fresh child process.
Repository order alternates by sample round when more than one --repo is used.
The existing one-shot form remains the default. Memory cache with compile-count
greater than one remains available for the incremental SDK workload.
`;

const valuesAfter = (args, name) =>
  args.flatMap((value, index) =>
    value === name && args[index + 1] ? [args[index + 1]] : [],
  );

const valueAfter = (args, name) => valuesAfter(args, name)[0];

const parseInteger = ({ args, name, fallback, minimum }) => {
  const value = Number.parseInt(valueAfter(args, name) ?? String(fallback), 10);
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer of at least ${minimum}`);
  }
  return value;
};

const gitOutput = (repository, args) => {
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

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const filesUnder = async (absolutePath) => {
  const metadata = await stat(absolutePath);
  if (metadata.isFile()) return [absolutePath];
  const entries = await readdir(absolutePath, { withFileTypes: true });
  const nested = await Promise.all(
    entries
      .filter(
        (entry) =>
          ![".git", ".turbo", "coverage", "dist", "node_modules"].includes(
            entry.name,
          ),
      )
      .map((entry) => filesUnder(path.join(absolutePath, entry.name))),
  );
  return nested.flat();
};

const hashInputs = async (repository, relativeInputs) => {
  const existingInputs = relativeInputs.filter((relativePath) =>
    existsSync(resolve(repository, relativePath)),
  );
  const files = (
    await Promise.all(
      existingInputs.map((relativePath) =>
        filesUnder(resolve(repository, relativePath)),
      ),
    )
  )
    .flat()
    .sort((left, right) => left.localeCompare(right));
  const hash = createHash("sha256");
  for (const file of files) {
    const relativePath = path.relative(repository, file).replaceAll("\\", "/");
    const contents = await readFile(file);
    hash.update(`${relativePath}\0${contents.byteLength}\0`);
    hash.update(contents);
    hash.update("\0");
  }
  return {
    sha256: hash.digest("hex"),
    fileCount: files.length,
    inputs: existingInputs,
    missingInputs: relativeInputs.filter(
      (relativePath) => !existingInputs.includes(relativePath),
    ),
  };
};

const installedDependencyHash = async (repository) => {
  const relativePath = "node_modules/.package-lock.json";
  const absolutePath = resolve(repository, relativePath);
  if (!existsSync(absolutePath)) return null;
  return {
    path: relativePath,
    sha256: sha256(await readFile(absolutePath)),
  };
};

const workspacePackageResolutions = async (repository) => {
  const resolutions = await Promise.all(
    WORKSPACE_PACKAGE_RESOLUTIONS.map(async ([packageName, packageFolder]) => {
      const installedPath = resolve(repository, "node_modules", packageName);
      if (!existsSync(installedPath)) {
        throw new Error(
          `${repository} is not installed: missing ${packageName} workspace link`,
        );
      }
      const [actualPath, expectedPath] = await Promise.all([
        realpath(installedPath),
        realpath(resolve(repository, "packages", packageFolder)),
      ]);
      if (actualPath !== expectedPath) {
        throw new Error(
          `${packageName} resolves outside the measured checkout: ${actualPath}; ` +
            `install dependencies in ${repository} instead of sharing another checkout's workspace links`,
        );
      }
      return [packageName, `packages/${packageFolder}`];
    }),
  );
  return Object.fromEntries(resolutions);
};

const repositoryMetadata = async ({ label, repository }) => {
  const entryPath = resolve(repository, ENTRY_RELATIVE_PATH);
  if (!existsSync(entryPath)) {
    throw new Error(`${repository} does not contain ${ENTRY_RELATIVE_PATH}`);
  }
  const [
    entrySource,
    sourceInputs,
    dependencyInputs,
    installedDependencies,
    workspaceResolutions,
  ] = await Promise.all([
    readFile(entryPath),
    hashInputs(repository, SOURCE_INPUTS),
    hashInputs(repository, DEPENDENCY_INPUTS),
    installedDependencyHash(repository),
    workspacePackageResolutions(repository),
  ]);
  return {
    label,
    repository,
    revision: gitOutput(repository, ["rev-parse", "HEAD"]),
    dirty: gitOutput(repository, ["status", "--porcelain"]).length > 0,
    hashes: {
      entrySourceSha256: sha256(entrySource),
      sourceInputs,
      dependencyInputs,
      installedDependencies,
      workspaceResolutions,
    },
  };
};

const parseRepositories = async (args) => {
  const values = valuesAfter(args, "--repo");
  const entries = values.length > 0 ? values : [`current=${repoRoot}`];
  const requested = entries.map((entry) => {
    const separator = entry.indexOf("=");
    if (separator <= 0 || separator === entry.length - 1) {
      throw new Error("--repo must use LABEL=/absolute/path");
    }
    return {
      label: entry.slice(0, separator),
      repository: resolve(entry.slice(separator + 1)),
    };
  });
  if (new Set(requested.map(({ label }) => label)).size !== requested.length) {
    throw new Error("--repo labels must be unique");
  }
  return Promise.all(requested.map(repositoryMetadata));
};

export const createExecutionPlan = ({
  repositoryLabels,
  warmupCount,
  sampleCount,
}) => {
  const rounds = (kind, count) =>
    Array.from({ length: count }, (_, round) => {
      const offset =
        repositoryLabels.length === 0
          ? 0
          : round % repositoryLabels.length;
      const ordered = [
        ...repositoryLabels.slice(offset),
        ...repositoryLabels.slice(0, offset),
      ];
      return ordered.map((repository) => ({ kind, round, repository }));
    }).flat();
  return [
    ...rounds("warmup", warmupCount),
    ...rounds("measured", sampleCount),
  ].map((entry, executionIndex) => ({ ...entry, executionIndex }));
};

export const summarizeDistribution = (input) => {
  if (input.length === 0 || input.some((value) => !Number.isFinite(value))) {
    throw new Error("cannot summarize an empty or non-finite distribution");
  }
  const values = [...input].sort((left, right) => left - right);
  const middle = Math.floor(values.length / 2);
  const median =
    values.length % 2 === 0
      ? (values[middle - 1] + values[middle]) / 2
      : values[middle];
  const p95 = values[Math.max(0, Math.ceil(values.length * 0.95) - 1)];
  return {
    values: [...input],
    min: values[0],
    median,
    p95,
    max: values.at(-1),
    mean: values.reduce((total, value) => total + value, 0) / values.length,
  };
};

const recordDistributions = (samples, select) => {
  const records = samples.map(select);
  const names = Array.from(
    new Set(records.flatMap((record) => Object.keys(record))),
  ).sort();
  return Object.fromEntries(
    names.map((name) => [
      name,
      summarizeDistribution(records.map((record) => record[name] ?? 0)),
    ]),
  );
};

const processMaxRssBytes = () => process.resourceUsage().maxRSS * 1024;

const loadWorkerCounterSchema = async (repository) => {
  const schemaPath = resolve(repository, V500_COUNTER_SCHEMA_RELATIVE_PATH);
  if (!existsSync(schemaPath)) {
    return { available: false, sourcePath: V500_COUNTER_SCHEMA_RELATIVE_PATH };
  }
  const schema = await import(pathToFileURL(schemaPath).href);
  const counters = schema.COMPILER_PERF_ZERO_PRESENCE_COUNTERS;
  if (
    !Array.isArray(counters) ||
    counters.some((counter) => typeof counter !== "string")
  ) {
    throw new Error(
      `${V500_COUNTER_SCHEMA_RELATIVE_PATH} does not export the closed counter schema`,
    );
  }
  return {
    available: true,
    sourcePath: V500_COUNTER_SCHEMA_RELATIVE_PATH,
    sourceSha256: sha256(await readFile(schemaPath)),
    counters,
  };
};

const runWorker = async (args) => {
  const repository = resolve(valueAfter(args, "--repository") ?? "");
  const compilerCache = valueAfter(args, "--compiler-cache") ?? "none";
  const compileCount = parseInteger({
    args,
    name: "--compile-count",
    fallback: 1,
    minimum: 1,
  });
  const initialMaxRssBytes = processMaxRssBytes();
  let counterSchema;
  try {
    counterSchema = await loadWorkerCounterSchema(repository);
    const { createSdk, detectSrcRootForPath } = await import(
      pathToFileURL(resolve(repository, "packages/sdk/src/index.ts")).href
    );
    const entryPath = resolve(repository, ENTRY_RELATIVE_PATH);
    const sdk = createSdk({ compilerCache });
    const options = {
      entryPath,
      roots: {
        src: detectSrcRootForPath(entryPath),
        std: resolve(repository, "packages/std/src"),
      },
      includeTests: true,
      testsOnly: true,
    };
    for (let index = 0; index < compileCount; index += 1) {
      const result = await sdk.compile(options);
      if (result.success) continue;
      process.stderr.write(`${JSON.stringify(result.diagnostics)}\n`);
      process.exitCode = 1;
      break;
    }
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  } finally {
    const maxRssBytes = processMaxRssBytes();
    writeFileSync(
      WORKER_REPORT_FD,
      JSON.stringify({
        initialMaxRssBytes,
        maxRssBytes,
        maxRssGrowthBytes: Math.max(0, maxRssBytes - initialMaxRssBytes),
        maxRssSource: "process.resourceUsage().maxRSS",
        counterSchema,
      }),
    );
  }
};

const parsePerfSummaries = (stderr) =>
  stderr
    .split(/\r?\n/u)
    .filter((line) => line.startsWith(PERF_PREFIX))
    .map((line) => {
      try {
        return JSON.parse(line.slice(PERF_PREFIX.length));
      } catch (error) {
        throw new Error(
          `invalid compiler perf summary: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });

export const validateCompilerSummaries = ({
  summaries,
  compileCount,
  counterSchema,
}) => {
  if (summaries.length !== compileCount) {
    return [
      `expected ${compileCount} compiler summaries but received ${summaries.length}`,
    ];
  }
  return summaries.flatMap((summary, compileIndex) => {
    const phases = summary.phasesMs ?? {};
    const counters = summary.counters ?? {};
    const requiredPhases = counterSchema?.available
      ? V500_REQUIRED_PHASES
      : ["total"];
    const requiredCounters = counterSchema?.available
      ? [
          ...STABLE_REQUIRED_ANALYSIS_COUNTERS,
          ...counterSchema.counters,
        ]
      : [];
    const missing = [
      ...requiredPhases.filter((name) => !(name in phases)),
      ...requiredCounters.filter((name) => !(name in counters)),
    ];
    return [
      ...(!summary.success ? [`compile ${compileIndex} reported failure`] : []),
      ...(missing.length > 0
        ? [`compile ${compileIndex} omitted metrics: ${missing.join(", ")}`]
        : []),
    ];
  });
};

const safeProfileName = (value) => value.replaceAll(/[^A-Za-z0-9_.-]/gu, "-");

const runSample = async ({
  repository,
  planEntry,
  compilerCache,
  compileCount,
  timeoutMs,
  cpuProfileDir,
}) => {
  const profileName = safeProfileName(
    `web-openapi-${repository.label}-${planEntry.kind}-${planEntry.round}.cpuprofile`,
  );
  const nodeArgs = [
    ...(cpuProfileDir
      ? [
          "--cpu-prof",
          `--cpu-prof-interval=${CPU_PROFILE_INTERVAL_US}`,
          `--cpu-prof-dir=${resolve(cpuProfileDir)}`,
          `--cpu-prof-name=${profileName}`,
        ]
      : []),
    "--import",
    "tsx",
    "--conditions=development",
    scriptPath,
    "--worker",
    "--repository",
    repository.repository,
    "--compiler-cache",
    compilerCache,
    "--compile-count",
    String(compileCount),
  ];
  const startedAt = performance.now();
  const child = spawn(process.execPath, nodeArgs, {
    cwd: repository.repository,
    env: {
      ...process.env,
      VOYD_COMPILER_PERF: "1",
      VOYD_USE_SRC: "1",
    },
    stdio: ["ignore", "pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let workerReportText = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdio[WORKER_REPORT_FD].setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdio[WORKER_REPORT_FD].on("data", (chunk) => {
    workerReportText += chunk;
  });

  let timedOut = false;
  let forceKill;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    forceKill = setTimeout(() => child.kill("SIGKILL"), WORKER_KILL_GRACE_MS);
  }, timeoutMs);
  const { code, signal } = await new Promise((accept, reject) => {
    child.on("error", reject);
    child.on("close", (exitCode, exitSignal) =>
      accept({ code: exitCode, signal: exitSignal }),
    );
  });
  clearTimeout(timeout);
  if (forceKill) clearTimeout(forceKill);
  const processWallMs = performance.now() - startedAt;
  const summaries = parsePerfSummaries(stderr);
  let workerReport = null;
  try {
    workerReport = JSON.parse(workerReportText);
  } catch {}
  const validationErrors = workerReport
    ? validateCompilerSummaries({
        summaries,
        compileCount,
        counterSchema: workerReport.counterSchema,
      })
    : ["worker did not report resource usage"];
  if (
    code !== 0 ||
    signal !== null ||
    timedOut ||
    !Number.isFinite(workerReport?.maxRssBytes) ||
    validationErrors.length > 0
  ) {
    process.stderr.write(stdout);
    process.stderr.write(stderr);
    throw new Error(
      `benchmark child failed for ${repository.label} ` +
        `(exit=${String(code)}, signal=${String(signal)}, timedOut=${timedOut}): ` +
        `${validationErrors.join("; ") || "invalid resource report"}`,
    );
  }
  return {
    executionIndex: planEntry.executionIndex,
    round: planEntry.round,
    processWallMs,
    peakRssBytes: workerReport.maxRssBytes,
    processMaxRssBytes: workerReport.maxRssBytes,
    processMaxRssGrowthBytes: workerReport.maxRssGrowthBytes,
    initialProcessMaxRssBytes: workerReport.initialMaxRssBytes,
    maxRssSource: workerReport.maxRssSource,
    exit: { code, signal, timedOut },
    stdout,
    stderr,
    compilerSummaries: summaries,
    compiler: summaries.at(-1),
    counterSchema: workerReport.counterSchema,
    ...(cpuProfileDir
      ? { cpuProfile: resolve(cpuProfileDir, profileName) }
      : {}),
  };
};

const summarizeRepository = ({ repository, warmups, samples }) => ({
  ...repository,
  methodology: {
    freshProcessPerSample: true,
    warmupsDiscardedFromDistributions: warmups.length,
    measuredSamples: samples.length,
    maxRssSource: "worker process.resourceUsage().maxRSS",
  },
  processWallMs: summarizeDistribution(
    samples.map((sample) => sample.processWallMs),
  ),
  peakRssBytes: summarizeDistribution(
    samples.map((sample) => sample.peakRssBytes),
  ),
  processMaxRssBytes: summarizeDistribution(
    samples.map((sample) => sample.processMaxRssBytes),
  ),
  processMaxRssGrowthBytes: summarizeDistribution(
    samples.map((sample) => sample.processMaxRssGrowthBytes),
  ),
  compiler: {
    phasesMs: recordDistributions(
      samples,
      (sample) => sample.compiler.phasesMs,
    ),
    counters: recordDistributions(
      samples,
      (sample) => sample.compiler.counters,
    ),
  },
  warmups,
  samples,
});

const ratio = (candidate, baseline) =>
  baseline === 0 ? null : candidate / baseline;

const compareResults = (baseline, candidates) =>
  candidates.map((candidate) => ({
    baseline: baseline.label,
    candidate: candidate.label,
    workloadSourceMatches:
      baseline.hashes.entrySourceSha256 === candidate.hashes.entrySourceSha256,
    medianRatios: {
      processWall:
        ratio(candidate.processWallMs.median, baseline.processWallMs.median),
      peakRss:
        ratio(candidate.peakRssBytes.median, baseline.peakRssBytes.median),
      processMaxRssGrowth: ratio(
        candidate.processMaxRssGrowthBytes.median,
        baseline.processMaxRssGrowthBytes.median,
      ),
      compilerTotal: ratio(
        candidate.compiler.phasesMs.total.median,
        baseline.compiler.phasesMs.total.median,
      ),
    },
  }));

const runController = async (args) => {
  if (args.includes("--help")) {
    process.stdout.write(HELP);
    return;
  }
  const timeoutMs = parseInteger({
    args,
    name: "--timeout-ms",
    fallback: DEFAULT_TIMEOUT_MS,
    minimum: 1,
  });
  const sampleCount = parseInteger({
    args,
    name: "--samples",
    fallback: 1,
    minimum: 1,
  });
  const warmupCount = parseInteger({
    args,
    name: "--warmups",
    fallback: 0,
    minimum: 0,
  });
  const compileCount = parseInteger({
    args,
    name: "--compile-count",
    fallback: 1,
    minimum: 1,
  });
  const compilerCache = valueAfter(args, "--compiler-cache") ?? "none";
  if (!["none", "memory"].includes(compilerCache)) {
    throw new Error("--compiler-cache must be none or memory");
  }
  const outputPath = valueAfter(args, "--output");
  const cpuProfileDir = valueAfter(args, "--cpu-profile-dir");
  const repositories = await parseRepositories(args);
  if (
    (repositories.length > 1 || sampleCount > 1 || warmupCount > 0) &&
    (compilerCache !== "none" || compileCount !== 1)
  ) {
    throw new Error(
      "repeated or comparative cold samples require --compiler-cache none --compile-count 1",
    );
  }
  if (args.includes("--require-clean")) {
    const dirty = repositories.filter((repository) => repository.dirty);
    if (dirty.length > 0) {
      throw new Error(
        `measured checkout must be clean: ${dirty.map(({ label }) => label).join(", ")}`,
      );
    }
  }
  if (
    repositories.length > 1 &&
    new Set(
      repositories.map((repository) => repository.hashes.entrySourceSha256),
    ).size > 1
  ) {
    throw new Error(
      `comparison checkouts must contain the same ${ENTRY_RELATIVE_PATH}`,
    );
  }
  if (cpuProfileDir) {
    await mkdir(resolve(cpuProfileDir), { recursive: true });
  }
  const plan = createExecutionPlan({
    repositoryLabels: repositories.map(({ label }) => label),
    warmupCount,
    sampleCount,
  });
  const samplesByRepository = new Map(
    repositories.map(({ label }) => [label, { warmups: [], samples: [] }]),
  );
  for (const planEntry of plan) {
    const repository = repositories.find(
      ({ label }) => label === planEntry.repository,
    );
    const sample = await runSample({
      repository,
      planEntry,
      compilerCache,
      compileCount,
      timeoutMs,
      cpuProfileDir,
    });
    const destination = samplesByRepository.get(repository.label);
    if (planEntry.kind === "warmup") destination.warmups.push(sample);
    else destination.samples.push(sample);
  }
  const results = repositories.map((repository) => {
    const samples = samplesByRepository.get(repository.label);
    return summarizeRepository({ repository, ...samples });
  });
  const cpu = cpus();
  const report = {
    schemaVersion: 2,
    benchmark: "web-openapi-package-scale",
    createdAt: new Date().toISOString(),
    entryPath: ENTRY_RELATIVE_PATH,
    harness: {
      path: path.relative(repoRoot, scriptPath).replaceAll("\\", "/"),
      sha256: sha256(await readFile(scriptPath)),
    },
    methodology: {
      freshProcessPerSample: true,
      exactFileTarget: true,
      testExecutionIncludedInProcessWall: true,
      compilerTotalExcludesTestExecution: true,
      compilerCache,
      compileCount,
      warmupCount,
      sampleCount,
      alternatingRepositoryOrder: repositories.length > 1,
      timeoutMsPerChild: timeoutMs,
      ...(cpuProfileDir
        ? { cpuProfileIntervalUs: CPU_PROFILE_INTERVAL_US }
        : {}),
    },
    environment: {
      node: process.version,
      platform: process.platform,
      release: release(),
      arch: process.arch,
      logicalCpuCount: cpu.length,
      cpuModel: cpu[0]?.model ?? "unknown",
      totalMemoryBytes: totalmem(),
    },
    executionPlan: plan,
    results,
    ...(results.length > 1
      ? { comparisons: compareResults(results[0], results.slice(1)) }
      : {}),
  };
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (outputPath) {
    const absoluteOutputPath = resolve(outputPath);
    await mkdir(dirname(absoluteOutputPath), { recursive: true });
    await writeFile(absoluteOutputPath, json);
  }
  process.stdout.write(json);
};

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (args.includes("--worker")) await runWorker(args);
  else await runController(args);
}
