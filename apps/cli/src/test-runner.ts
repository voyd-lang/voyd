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
  modulePathToString,
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
  return modulePathToString(modulePath);
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

  const summary: TestRunSummary = {
    total: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    durationMs: 0,
  };

  let hadTests = false;
  const startRun = Date.now();

  for (const filePath of files) {
    const modulePath = buildModulePath({
      filePath,
      roots,
      pathAdapter: host.path,
    });
    const result = await sdk.compile({
      entryPath: filePath,
      includeTests: true,
      testsOnly: true,
      roots,
    });

    const tests = result.tests;
    if (!tests) {
      continue;
    }

    const hasModuleTests = tests.cases.some(
      (test) => test.modulePath === modulePath,
    );
    if (!hasModuleTests) {
      continue;
    }

    hadTests = true;

    const moduleSummary = await tests.run({
      reporter: cliReporter,
      filter: (info) => info.modulePath === modulePath,
    });

    summary.total += moduleSummary.total;
    summary.passed += moduleSummary.passed;
    summary.failed += moduleSummary.failed;
    summary.skipped += moduleSummary.skipped;
  }

  summary.durationMs = Date.now() - startRun;

  if (!hadTests) {
    if (reporter !== "silent") {
      console.log("No tests found.");
    }
    return summary;
  }

  reportSummary(summary, reporter);

  if (summary.failed > 0) {
    process.exitCode = 1;
  }

  return summary;
};
