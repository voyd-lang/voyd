import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";

const options = parseArgs(process.argv.slice(2));
const budgets = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "timing-budgets.json"), "utf8"),
);
const budget = budgets[options.lane];
if (!budget) {
  throw new Error(`Unknown timing lane: ${options.lane}`);
}

const rawReports = findJsonFiles(resolve(options.directory))
  .filter((file) => resolve(file) !== resolve(options.output))
  .map(readReport);
const reports = rawReports.filter(
  (report) =>
    Number.isFinite(report.startTime) && Array.isArray(report.testResults),
);
const laneWallReports = rawReports.filter(
  (report) =>
    report.kind === "lane-wall" &&
    report.lane === options.lane &&
    Number.isFinite(report.wallMs),
);
if (reports.length === 0 && laneWallReports.length === 0) {
  const emptySummary = {
    lane: options.lane,
    generatedAt: new Date().toISOString(),
    wallMs: 0,
    totalFileMs: 0,
    reportCount: 0,
    files: [],
    slowestTests: [],
    budget,
    note: "No timed command or Vitest task executed.",
  };
  writeFileSync(
    resolve(options.output),
    `${JSON.stringify(emptySummary, null, 2)}\n`,
  );
  process.stdout.write(`${options.lane}: no executed Vitest reports\n`);
  process.exit(0);
}

const files = reports
  .flatMap((report) => report.testResults ?? [])
  .map((result) => ({
    file: result.name,
    durationMs: Math.max(0, result.endTime - result.startTime),
    tests: (result.assertionResults ?? []).map((test) => ({
      name: test.fullName,
      durationMs: test.duration ?? 0,
      status: test.status,
    })),
  }))
  .sort((left, right) => right.durationMs - left.durationMs);
const reportStarts = reports.map((report) => report.startTime);
const reportEnds = reports.flatMap((report) =>
  (report.testResults ?? []).map((result) => result.endTime),
);
const vitestWallMs =
  reportStarts.length > 0 && reportEnds.length > 0
    ? Math.max(...reportEnds) - Math.min(...reportStarts)
    : 0;
const wallMs =
  laneWallReports.length > 0
    ? Math.max(...laneWallReports.map((report) => report.wallMs))
    : vitestWallMs;
const totalFileMs = files.reduce((total, file) => total + file.durationMs, 0);
const slowestTests = files
  .flatMap((file) => file.tests.map((test) => ({ file: file.file, ...test })))
  .sort((left, right) => right.durationMs - left.durationMs)
  .slice(0, 20);
const summary = {
  lane: options.lane,
  generatedAt: new Date().toISOString(),
  wallMs,
  totalFileMs,
  reportCount: reports.length,
  commandWalls: laneWallReports.map((report) => ({
    command: report.command,
    wallMs: report.wallMs,
    status: report.status,
  })),
  files,
  slowestTests,
  budget,
};

writeFileSync(resolve(options.output), `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(
  `${options.lane}: wall=${formatMs(wallMs)} total-file=${formatMs(totalFileMs)} reports=${reports.length}\n`,
);
files.slice(0, 10).forEach((file) => {
  process.stdout.write(`  ${formatMs(file.durationMs)} ${file.file}\n`);
});

const violations = [
  ...(wallMs > budget.maxWallMs
    ? [`wall time ${formatMs(wallMs)} exceeds ${formatMs(budget.maxWallMs)}`]
    : []),
  ...files
    .filter((file) => file.durationMs > budget.maxFileMs)
    .map(
      (file) =>
        `${basename(file.file)} ${formatMs(file.durationMs)} exceeds ${formatMs(budget.maxFileMs)}`,
    ),
];
if (violations.length > 0) {
  throw new Error(`Test timing budget exceeded:\n${violations.join("\n")}`);
}

function parseArgs(args) {
  const valueFor = (name) => {
    const index = args.indexOf(name);
    if (index < 0 || !args[index + 1]) throw new Error(`Missing ${name}`);
    return args[index + 1];
  };
  return {
    directory: valueFor("--dir"),
    lane: valueFor("--lane"),
    output: valueFor("--output"),
  };
}

function findJsonFiles(directory) {
  return readdirSync(directory).flatMap((entry) => {
    const path = resolve(directory, entry);
    if (statSync(path).isDirectory()) return findJsonFiles(path);
    return entry.endsWith(".json") ? [path] : [];
  });
}

function readReport(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function formatMs(value) {
  return `${Math.round(value)}ms`;
}
