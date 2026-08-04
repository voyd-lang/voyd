import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { cpus, totalmem } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PERF_PREFIX = "[voyd:compiler:perf] ";
const DEFAULT_TIMEOUT_MS = 900_000;
const CPU_PROFILE_INTERVAL_US = 10_000;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const entryPath = resolve(
  repoRoot,
  "packages/web/src/openapi/openapi_app.test.voyd",
);

const valueAfter = (name) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};

const timeoutMs = Number(valueAfter("--timeout-ms") ?? DEFAULT_TIMEOUT_MS);
const cpuProfileDir = valueAfter("--cpu-profile-dir");
const compilerCache = valueAfter("--compiler-cache") ?? "none";
const compileCount = Number(valueAfter("--compile-count") ?? 1);
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
  throw new Error("--timeout-ms must be a positive number");
}
if (!["none", "memory", "artifact"].includes(compilerCache)) {
  throw new Error("--compiler-cache must be none, memory, or artifact");
}
if (!Number.isInteger(compileCount) || compileCount < 1) {
  throw new Error("--compile-count must be a positive integer");
}
if (cpuProfileDir) {
  await mkdir(resolve(cpuProfileDir), { recursive: true });
}

const nodeArgs = [
  ...(cpuProfileDir
    ? [
        "--cpu-prof",
        `--cpu-prof-interval=${CPU_PROFILE_INTERVAL_US}`,
        `--cpu-prof-dir=${resolve(cpuProfileDir)}`,
        "--cpu-prof-name=web-openapi-package-scale.cpuprofile",
      ]
    : []),
  "--import",
  "tsx",
  "--conditions=development",
  "--input-type=module",
  "--eval",
  `import { createSdk, detectSrcRootForPath } from "@voyd-lang/sdk";
import { resolveStdRoot } from "@voyd-lang/lib/resolve-std.js";
const entryPath = process.env.VOYD_BENCH_ENTRY_PATH;
const compilerCache = process.env.VOYD_BENCH_COMPILER_CACHE;
const compileCount = Number(process.env.VOYD_BENCH_COMPILE_COUNT);
const sdk = createSdk({ compilerCache });
const options = {
  entryPath,
  roots: { src: detectSrcRootForPath(entryPath), std: resolveStdRoot() },
  includeTests: true,
  testsOnly: true,
};
for (let index = 0; index < compileCount; index += 1) {
  const result = await sdk.compile(options);
  if (!result.success) {
    console.error(JSON.stringify(result.diagnostics));
    process.exitCode = 1;
    break;
  }
}
if (compilerCache === "artifact") {
  process.stdout.write(JSON.stringify(sdk.exportCompilerArtifact()) + "\\n");
}`,
];

const startedAt = performance.now();
const child = spawn(process.execPath, nodeArgs, {
  cwd: repoRoot,
  env: {
    ...process.env,
    VOYD_COMPILER_PERF: "1",
    VOYD_USE_SRC: "1",
    VOYD_BENCH_ENTRY_PATH: entryPath,
    VOYD_BENCH_COMPILER_CACHE: compilerCache,
    VOYD_BENCH_COMPILE_COUNT: String(compileCount),
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  stdout += chunk;
});
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});

const timeout = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
const { code, signal } = await new Promise((accept, reject) => {
  child.on("error", reject);
  child.on("exit", (exitCode, exitSignal) =>
    accept({ code: exitCode, signal: exitSignal }),
  );
});
clearTimeout(timeout);
const processWallMs = performance.now() - startedAt;
const resourceUsage = child.resourceUsage?.();

const summaries = stderr
  .split(/\r?\n/u)
  .filter((line) => line.startsWith(PERF_PREFIX))
  .map((line) => JSON.parse(line.slice(PERF_PREFIX.length)));

if (code !== 0 || summaries.length !== compileCount) {
  process.stderr.write(stdout);
  process.stderr.write(stderr);
  throw new Error(
    `benchmark child failed (exit=${String(code)}, signal=${String(signal)}, compiler summaries=${summaries.length})`,
  );
}

const compiler = summaries.at(-1);
const requiredPhases = [
  "total",
  "analyzeBorrowing",
  "analyzeBorrowing.checkLoans",
  "borrowing.body.scanFacts",
];
const requiredCounters = [
  "borrowing.body.checkedCallables",
  "borrowing.body.totalCallables",
  "borrowing.facts.blocks",
  "borrowing.facts.operations",
];
const missing = [
  ...requiredPhases.filter((name) => !(name in compiler.phasesMs)),
  ...requiredCounters.filter((name) => !(name in compiler.counters)),
];
if (!compiler.success || missing.length > 0) {
  throw new Error(
    `compiler benchmark summary is incomplete: ${missing.join(", ") || "compile failed"}`,
  );
}

const cpu = cpus();
const result = {
  schemaVersion: 1,
  benchmark: "web-openapi-package-scale",
  entryPath: "packages/web/src/openapi/openapi_app.test.voyd",
  methodology: {
    freshProcess: true,
    exactFileTarget: true,
    testExecutionIncludedInProcessWall: true,
    compilerTotalExcludesTestExecution: true,
    compilerCache,
    compileCount,
    ...(cpuProfileDir
      ? { cpuProfileIntervalUs: CPU_PROFILE_INTERVAL_US }
      : {}),
  },
  environment: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    logicalCpuCount: cpu.length,
    cpuModel: cpu[0]?.model ?? "unknown",
    totalMemoryBytes: totalmem(),
  },
  processWallMs: Math.round(processWallMs * 1000) / 1000,
  ...(resourceUsage?.maxRSS
    ? { maxRssBytes: resourceUsage.maxRSS * 1024 }
    : {}),
  compiler: {
    success: compiler.success,
    diagnostics: compiler.diagnostics,
    phasesMs: compiler.phasesMs,
    counters: compiler.counters,
  },
  ...(compileCount > 1
    ? {
        priorCompiles: summaries.slice(0, -1).map((summary) => ({
          phasesMs: summary.phasesMs,
          counters: summary.counters,
        })),
      }
    : {}),
  ...(cpuProfileDir
    ? { cpuProfile: resolve(cpuProfileDir, "web-openapi-package-scale.cpuprofile") }
    : {}),
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
