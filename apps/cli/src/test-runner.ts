import { readdir, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  createSdk,
  type TestEvent,
  type TestReporter,
  type TestRunSummary,
} from "@voyd/sdk";
import {
  createFsModuleHost,
  EFFECTS_HOST_BOUNDARY_STD_DEPS,
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

const isWithinRoot = (root: string, target: string): boolean => {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
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
  const prelude: string[] = [];
  EFFECTS_HOST_BOUNDARY_STD_DEPS.forEach((moduleId) => {
    if (!modulePaths.includes(moduleId)) {
      const alias = moduleId.replace(/[^A-Za-z0-9_]/g, "_");
      prelude.push(`use ${moduleId}::self as ${alias}`);
    }
  });

  const uses = modulePaths.map(
    (modulePath, index) => `use ${modulePath}::self as test_mod_${index}`
  );
  return [...prelude, ...uses].join("\n");
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
  failOnEmptyTests = false,
}: {
  rootPath: string;
  reporter?: string;
  failOnEmptyTests?: boolean;
}): Promise<TestRunSummary> => {
  const host = createFsModuleHost();
  const { scanRoot, roots } = resolveRoots(rootPath);
  const stdRoot = roots.std ?? resolveStdRoot();
  const isTestingStd = isWithinRoot(stdRoot, scanRoot);
  const files = await findVoydFiles(scanRoot);
  const cliReporter = createCliReporter(reporter);

  if (files.length === 0) {
    if (reporter !== "silent") {
      console.log("No tests found.");
    }
    if (failOnEmptyTests) {
      process.exitCode = 1;
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
    testScope: "all",
    roots,
  });
  if (!result.success) {
    throw { diagnostics: result.diagnostics };
  }

  const tests = result.tests;
  if (!tests || tests.cases.length === 0) {
    if (reporter !== "silent") {
      console.log("No tests found.");
    }
    if (failOnEmptyTests) {
      process.exitCode = 1;
    }
    return {
      total: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      durationMs: Date.now() - startRun,
    };
  }

  const allowedFiles = new Set(files.map((filePath) => resolve(filePath)));
  const allowedModules = new Set(modulePaths);
  const summary = await tests.run({
    reporter: cliReporter,
    filter: (info) => {
      if (!isTestingStd) {
        if (info.modulePath.startsWith("std::")) {
          return false;
        }
        if (
          info.location?.filePath &&
          isWithinRoot(stdRoot, resolve(info.location.filePath))
        ) {
          return false;
        }
      }
      if (info.location?.filePath) {
        return allowedFiles.has(resolve(info.location.filePath));
      }
      return allowedModules.has(info.modulePath);
    },
  });
  const finalSummary = { ...summary, durationMs: Date.now() - startRun };

  reportSummary(finalSummary, reporter);

  if (finalSummary.failed > 0) {
    process.exitCode = 1;
  }

  return finalSummary;
};
