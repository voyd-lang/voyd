import { readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  createSdk,
  type TestEvent,
  type TestReporter,
  type TestRunSummary,
} from "@voyd/sdk";
import {
  createFsModuleHost,
  modulePathFromFile,
  type ModuleRoots,
} from "@voyd/sdk/compiler";
import { resolveStdRoot } from "@voyd/lib/resolve-std.js";

const sdk = createSdk();

type CliTestResult = {
  displayName: string;
  status: "passed" | "failed" | "skipped";
  durationMs: number;
  error?: unknown;
};

const shouldSkipDir = (name: string): boolean => {
  if (name.startsWith(".")) return true;
  return (
    name === "node_modules" ||
    name === "dist" ||
    name === "build" ||
    name === "target" ||
    name === ".turbo"
  );
};

const findVoydFiles = async (rootPath: string): Promise<string[]> => {
  const info = await stat(rootPath);
  if (info.isFile()) {
    return rootPath.endsWith(".voyd") ? [rootPath] : [];
  }

  if (!info.isDirectory()) {
    return [];
  }

  const entries = await readdir(rootPath, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (shouldSkipDir(entry.name)) {
        continue;
      }
      const nested = await findVoydFiles(join(rootPath, entry.name));
      files.push(...nested);
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".voyd")) {
      files.push(join(rootPath, entry.name));
    }
  }

  return files;
};

const resolveRoots = (
  rootPath: string,
): { scanRoot: string; roots: ModuleRoots } => {
  const resolved = resolve(rootPath);
  const scanRoot = resolved;
  const srcRoot = resolved.endsWith(".voyd") ? dirname(resolved) : resolved;
  return { scanRoot, roots: { src: srcRoot, std: resolveStdRoot() } };
};

const SIMPLE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

const escapeIdentifier = (value: string): string =>
  value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

const formatSegment = (segment: string): string =>
  SIMPLE_IDENTIFIER.test(segment) ? segment : `'${escapeIdentifier(segment)}'`;

const formatModulePathForUse = ({
  namespace,
  segments,
  packageName,
}: ReturnType<typeof modulePathFromFile>): string => {
  const prefix =
    namespace === "pkg" && packageName
      ? [namespace, packageName]
      : [namespace];
  return [...prefix, ...segments].map(formatSegment).join("::");
};

const buildModulePath = ({
  filePath,
  roots,
  pathAdapter,
}: {
  filePath: string;
  roots: ModuleRoots;
  pathAdapter: ReturnType<typeof createFsModuleHost>["path"];
}): string => {
  const modulePath = modulePathFromFile(filePath, roots, pathAdapter);
  return formatModulePathForUse(modulePath);
};

const buildTestEntrySource = ({
  modulePaths,
}: {
  modulePaths: string[];
}): string => {
  return modulePaths
    .map(
      (modulePath, index) =>
        `use ${modulePath}::self as test_mod_${index}`
    )
    .join("\n");
};

const resolveTestEntryPath = ({
  roots,
  existingFiles,
}: {
  roots: ModuleRoots;
  existingFiles: string[];
}): string => {
  const existing = new Set(existingFiles.map((filePath) => resolve(filePath)));
  const base = join(roots.src, "__voyd_test_entry__");
  let index = 0;
  let candidate = `${base}.voyd`;
  while (existing.has(resolve(candidate))) {
    index += 1;
    candidate = `${base}_${index}.voyd`;
  }
  return candidate;
};

const formatResultLabel = (result: CliTestResult): string => {
  if (result.status === "passed") return "PASS";
  if (result.status === "skipped") return "SKIP";
  return "FAIL";
};

const reportResult = (result: CliTestResult, reporter: string): void => {
  if (reporter === "silent") {
    return;
  }

  const label = formatResultLabel(result);
  const line = `${label} ${result.displayName}`;
  if (result.status === "failed") {
    console.error(line);
    if (result.error instanceof Error && result.error.message) {
      console.error(`  ${result.error.message}`);
    }
    return;
  }

  console.log(line);
};

const reportSummary = (summary: TestRunSummary, reporter: string): void => {
  if (reporter === "silent") {
    return;
  }

  const details = `passed ${summary.passed}, failed ${summary.failed}, skipped ${summary.skipped}`;
  console.log(`\n${details} (${summary.total} total)`);
};

const createCliReporter = (reporter: string): TestReporter => {
  if (reporter === "silent") {
    return { onEvent: () => undefined };
  }

  return {
    onEvent: (event: TestEvent) => {
      if (event.type !== "test:result") {
        return;
      }
      reportResult(event.result, reporter);
    },
  };
};

export const runTests = async ({
  rootPath,
  reporter = "default",
}: {
  rootPath: string;
  reporter?: string;
}): Promise<TestRunSummary> => {
  const host = createFsModuleHost();
  const { scanRoot, roots } = resolveRoots(rootPath);
  const files = await findVoydFiles(scanRoot);
  const cliReporter = createCliReporter(reporter);

  if (files.length === 0) {
    if (reporter !== "silent") {
      console.log("No tests found.");
    }
    return {
      total: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      durationMs: 0,
    };
  }

  const modulePaths = files.map((filePath) =>
    buildModulePath({ filePath, roots, pathAdapter: host.path })
  );
  const entryPath = resolveTestEntryPath({ roots, existingFiles: files });
  const entrySource = buildTestEntrySource({ modulePaths });

  const startRun = Date.now();
  const result = await sdk.compile({
    entryPath,
    source: entrySource,
    includeTests: true,
    testsOnly: true,
    roots,
  });

  const tests = result.tests;
  if (!tests || tests.cases.length === 0) {
    if (reporter !== "silent") {
      console.log("No tests found.");
    }
    return {
      total: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      durationMs: Date.now() - startRun,
    };
  }

  const summary = await tests.run({ reporter: cliReporter });
  const finalSummary = { ...summary, durationMs: Date.now() - startRun };

  reportSummary(finalSummary, reporter);

  if (finalSummary.failed > 0) {
    process.exitCode = 1;
  }

  return finalSummary;
};
