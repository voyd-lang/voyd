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
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
  throw new Error("--timeout-ms must be a positive number");
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
  resolve(repoRoot, "apps/cli/src/cli.ts"),
  "test",
  entryPath,
  "--reporter=silent",
  "--fail-empty-tests",
];

const startedAt = performance.now();
const child = spawn(process.execPath, nodeArgs, {
  cwd: repoRoot,
  env: {
    ...process.env,
    VOYD_COMPILER_PERF: "1",
    VOYD_USE_SRC: "1",
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

const summaries = stderr
  .split(/\r?\n/u)
  .filter((line) => line.startsWith(PERF_PREFIX))
  .map((line) => JSON.parse(line.slice(PERF_PREFIX.length)));

if (code !== 0 || summaries.length !== 1) {
  process.stderr.write(stdout);
  process.stderr.write(stderr);
  throw new Error(
    `benchmark child failed (exit=${String(code)}, signal=${String(signal)}, compiler summaries=${summaries.length})`,
  );
}

const [compiler] = summaries;
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
  compiler: {
    success: compiler.success,
    diagnostics: compiler.diagnostics,
    phasesMs: compiler.phasesMs,
    counters: compiler.counters,
  },
  ...(cpuProfileDir
    ? { cpuProfile: resolve(cpuProfileDir, "web-openapi-package-scale.cpuprofile") }
    : {}),
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
