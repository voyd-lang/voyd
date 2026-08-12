import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  createSdk,
  detectSrcRootForPath,
  type TestCase,
  type TestCollection,
  type TestEvent,
  type TestReporter,
  type TestResult,
  type TestRunSummary,
} from "@voyd-lang/sdk";
import {
  createFsModuleHost,
  SELECTED_HOST_TRANSPORT_PROVIDER_MODULES,
  modulePathFromFile,
  type ModuleRoots,
} from "@voyd-lang/sdk/compiler";
import { resolveStdRoot } from "@voyd-lang/lib/resolve-std.js";
import { resolvePackageDirs } from "./package-dirs.js";
import type { TestShard } from "./config/types.js";

// Package-aware directory runs compile independent test programs, so reusable
// semantics must not carry package-local entry state between batches.
const sdk = createSdk({ compilerCache: "none" });

const TEST_DECLARATION_PATTERN = /(^|[\r\n])\s*test(?=[^A-Za-z0-9_]|$)/;

const emptySummary = ({
  durationMs,
}: {
  durationMs: number;
}): TestRunSummary => ({
  total: 0,
  passed: 0,
  failed: 0,
  skipped: 0,
  durationMs,
});

const reportNoTestsFound = ({
  reporter,
  targetPath,
  failOnEmptyTests,
  durationMs,
}: {
  reporter: string;
  targetPath: string;
  failOnEmptyTests: boolean;
  durationMs: number;
}): TestRunSummary => {
  if (reporter !== "silent") {
    console.log(`[discovery] No tests found for target: ${targetPath}`);
  }
  if (failOnEmptyTests) {
    process.exitCode = 1;
  }
  return emptySummary({ durationMs });
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

const TEST_COMPANION_SUFFIX = ".test.voyd";
const VOYD_SUFFIX = ".voyd";

const isMissingPathError = (error: unknown): boolean => {
  if (!error || typeof error !== "object") {
    return false;
  }

  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
};

const companionFileFor = (filePath: string): string =>
  `${filePath.slice(0, -VOYD_SUFFIX.length)}${TEST_COMPANION_SUFFIX}`;

const primaryFileForCompanion = (filePath: string): string =>
  `${filePath.slice(0, -TEST_COMPANION_SUFFIX.length)}${VOYD_SUFFIX}`;

const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    const info = await stat(filePath);
    return info.isFile();
  } catch (error) {
    if (isMissingPathError(error)) {
      return false;
    }
    throw error;
  }
};

const isCompanionTestFile = ({
  filePath,
  knownFiles,
}: {
  filePath: string;
  knownFiles: ReadonlySet<string>;
}): boolean => {
  if (!filePath.endsWith(TEST_COMPANION_SUFFIX)) {
    return false;
  }

  const basePath = primaryFileForCompanion(filePath);
  return knownFiles.has(resolve(basePath));
};

const enrichFileTargetWithCompanion = async ({
  scanRoot,
  files,
}: {
  scanRoot: string;
  files: readonly string[];
}): Promise<string[]> => {
  const resolvedScanRoot = resolve(scanRoot);
  if (!resolvedScanRoot.endsWith(VOYD_SUFFIX)) {
    return [...files];
  }
  if (!files.some((filePath) => resolve(filePath) === resolvedScanRoot)) {
    return [...files];
  }

  const counterpart = resolvedScanRoot.endsWith(TEST_COMPANION_SUFFIX)
    ? primaryFileForCompanion(resolvedScanRoot)
    : companionFileFor(resolvedScanRoot);
  if (!(await fileExists(counterpart))) {
    return [...files];
  }

  return [...new Set([...files, counterpart])];
};

const sourceContainsTestDeclaration = async (
  filePath: string,
): Promise<boolean> => {
  const source = await readFile(filePath, "utf8");
  return TEST_DECLARATION_PATTERN.test(source);
};

const selectTestModules = async ({
  moduleFiles,
  knownFiles,
}: {
  moduleFiles: readonly string[];
  knownFiles: ReadonlySet<string>;
}): Promise<string[]> => {
  const selected = await Promise.all(
    moduleFiles.map(async (filePath) => {
      if (!filePath.endsWith(TEST_COMPANION_SUFFIX)) {
        const companionPath = resolve(companionFileFor(filePath));
        if (
          knownFiles.has(companionPath) &&
          (await sourceContainsTestDeclaration(companionPath))
        ) {
          return filePath;
        }
      }

      return (await sourceContainsTestDeclaration(filePath))
        ? filePath
        : undefined;
    }),
  );

  return selected.filter((filePath): filePath is string => Boolean(filePath));
};

export const selectTestShard = (
  values: readonly string[],
  shard?: TestShard,
): string[] => {
  const sorted = [...values].sort((left, right) => left.localeCompare(right));
  if (!shard) return sorted;
  return sorted.filter((_value, index) => index % shard.count === shard.index);
};

const buildAllowedTestFiles = ({
  testModules,
  knownFiles,
}: {
  testModules: readonly string[];
  knownFiles: ReadonlySet<string>;
}): Set<string> => {
  const allowedFiles = new Set<string>();

  testModules.forEach((filePath) => {
    const resolvedFilePath = resolve(filePath);
    allowedFiles.add(resolvedFilePath);

    if (resolvedFilePath.endsWith(TEST_COMPANION_SUFFIX)) {
      const primaryFilePath = resolve(
        primaryFileForCompanion(resolvedFilePath),
      );
      if (knownFiles.has(primaryFilePath)) {
        allowedFiles.add(primaryFilePath);
      }
      return;
    }

    const companionFilePath = resolve(companionFileFor(resolvedFilePath));
    if (knownFiles.has(companionFilePath)) {
      allowedFiles.add(companionFilePath);
    }
  });

  return allowedFiles;
};

const resolveRoots = (
  rootPath: string,
  pkgDirs: readonly string[] = [],
): { scanRoot: string; roots: ModuleRoots } => {
  const resolved = resolve(rootPath);
  const inferredSrcRoot = detectSrcRootForPath(resolved);
  const scanRoot = resolved;
  const srcRoot = inferredSrcRoot;
  return {
    scanRoot,
    roots: {
      src: srcRoot,
      std: resolveStdRoot(),
      pkgDirs: resolvePackageDirs({
        srcRoot,
        additionalPkgDirs: pkgDirs,
      }),
    },
  };
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
    namespace === "pkg" && packageName ? [namespace, packageName] : [namespace];
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
  const segments =
    pathAdapter.basename(filePath) === "pkg.voyd"
      ? modulePath.segments.slice(0, -1)
      : modulePath.segments;
  return formatModulePathForUse({ ...modulePath, segments });
};

const buildTestEntrySource = ({
  modulePaths,
}: {
  modulePaths: string[];
}): string => {
  const prelude: string[] = [];
  SELECTED_HOST_TRANSPORT_PROVIDER_MODULES.forEach((moduleId) => {
    if (!modulePaths.includes(moduleId)) {
      const alias = moduleId.replace(/[^A-Za-z0-9_]/g, "_");
      prelude.push(`use ${moduleId}::self as ${alias}`);
    }
  });

  const uses = modulePaths.map(
    (modulePath, index) => `use ${modulePath}::self as test_mod_${index}`,
  );
  return [...prelude, ...uses].join("\n");
};

const resolveTestEntryPath = ({
  entryDir,
  existingFiles,
}: {
  entryDir: string;
  existingFiles: string[];
}): string => {
  const existing = new Set(existingFiles.map((filePath) => resolve(filePath)));
  const base = join(entryDir, "__voyd_test_entry__");
  let index = 0;
  let candidate = `${base}.voyd`;
  while (existing.has(resolve(candidate))) {
    index += 1;
    candidate = `${base}_${index}.voyd`;
  }
  return candidate;
};

const findOwningSourcePackageDir = async ({
  filePath,
  srcRoot,
}: {
  filePath: string;
  srcRoot: string;
}): Promise<string> => {
  const resolvedSrcRoot = resolve(srcRoot);
  let candidate = dirname(resolve(filePath));

  while (isWithinRoot(resolvedSrcRoot, candidate)) {
    if (await fileExists(join(candidate, "pkg.voyd"))) {
      return candidate;
    }
    if (candidate === resolvedSrcRoot) {
      break;
    }
    const parent = dirname(candidate);
    if (parent === candidate) {
      break;
    }
    candidate = parent;
  }

  return resolvedSrcRoot;
};

const groupTestModulesBySourcePackage = async ({
  testModules,
  srcRoot,
}: {
  testModules: readonly string[];
  srcRoot: string;
}): Promise<Map<string, string[]>> => {
  const groups = new Map<string, string[]>();
  for (const filePath of testModules) {
    const packageDir = await findOwningSourcePackageDir({ filePath, srcRoot });
    const group = groups.get(packageDir) ?? [];
    group.push(filePath);
    groups.set(packageDir, group);
  }
  return groups;
};

const formatResultLabel = (result: TestResult): string => {
  if (result.status === "passed") return "PASS";
  if (result.status === "skipped") return "SKIP";
  return "FAIL";
};

const reportResult = (result: TestResult, reporter: string): void => {
  if (reporter === "silent") {
    return;
  }

  const label = formatResultLabel(result);
  const location = result.test.location
    ? ` (${result.test.location.filePath}:${result.test.location.startLine}:${result.test.location.startColumn})`
    : "";
  const line = `${label} ${result.displayName}${result.status === "failed" ? location : ""}`;
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

const buildTestDisplayName = (test: TestCase): string => {
  if (test.description) {
    return `${test.modulePath}::${test.description}`;
  }
  if (test.location) {
    return `${test.modulePath}::<${test.location.filePath}:${test.location.startLine}:${test.location.startColumn}>`;
  }
  return `${test.modulePath}::<${test.id}>`;
};

type PreparedTestBatch = {
  tests: TestCollection;
  eligibleCases: readonly TestCase[];
  includes: (test: Pick<TestCase, "location" | "modulePath">) => boolean;
};

const addSummary = (
  left: TestRunSummary,
  right: TestRunSummary,
): TestRunSummary => ({
  total: left.total + right.total,
  passed: left.passed + right.passed,
  failed: left.failed + right.failed,
  skipped: left.skipped + right.skipped,
  durationMs: left.durationMs + right.durationMs,
});

const skipBatch = ({
  cases,
  reporter,
}: {
  cases: readonly TestCase[];
  reporter: string;
}): TestRunSummary => {
  cases.forEach((test) => {
    reportResult(
      {
        test,
        displayName: buildTestDisplayName(test),
        status: "skipped",
        durationMs: 0,
      },
      reporter,
    );
  });
  return {
    total: cases.length,
    passed: 0,
    failed: 0,
    skipped: cases.length,
    durationMs: 0,
  };
};

export const runTests = async ({
  rootPath,
  reporter = "default",
  failOnEmptyTests = false,
  shard,
  pkgDirs = [],
}: {
  rootPath: string;
  reporter?: string;
  failOnEmptyTests?: boolean;
  shard?: TestShard;
  pkgDirs?: readonly string[];
}): Promise<TestRunSummary> => {
  const host = createFsModuleHost();
  const { scanRoot, roots } = resolveRoots(rootPath, pkgDirs);
  const stdRoot = roots.std ?? resolveStdRoot();
  const isTestingStd = isWithinRoot(stdRoot, scanRoot);
  const discoveredFiles = await enrichFileTargetWithCompanion({
    scanRoot,
    files: await findVoydFiles(scanRoot),
  });
  const files = discoveredFiles;
  const knownFiles = new Set(files.map((filePath) => resolve(filePath)));
  const moduleFiles = files.filter(
    (filePath) => !isCompanionTestFile({ filePath, knownFiles }),
  );
  const testModules = selectTestShard(
    await selectTestModules({ moduleFiles, knownFiles }),
    shard,
  );
  const cliReporter = createCliReporter(reporter);

  if (testModules.length === 0) {
    return reportNoTestsFound({
      reporter,
      targetPath: scanRoot,
      failOnEmptyTests,
      durationMs: 0,
    });
  }

  const startRun = Date.now();
  const groupedModules = await groupTestModulesBySourcePackage({
    testModules,
    srcRoot: roots.src,
  });
  const batches: PreparedTestBatch[] = [];

  for (const [packageDir, packageTestModules] of groupedModules) {
    const modulePaths = packageTestModules.map((filePath) =>
      buildModulePath({ filePath, roots, pathAdapter: host.path }),
    );
    const entryPath = resolveTestEntryPath({
      entryDir: packageDir,
      existingFiles: files,
    });
    const result = await sdk.compile({
      entryPath,
      source: buildTestEntrySource({ modulePaths }),
      includeTests: true,
      testsOnly: true,
      testScope: "all",
      roots,
    });
    if (!result.success) {
      throw {
        diagnostics: result.diagnostics,
        testPhase: "typing",
        testTargetPath: scanRoot,
      };
    }

    const tests = result.tests;
    if (!tests) {
      continue;
    }
    const allowedFiles = buildAllowedTestFiles({
      testModules: packageTestModules,
      knownFiles,
    });
    const allowedModules = new Set(modulePaths);
    const includes = (info: Pick<TestCase, "location" | "modulePath">) => {
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
    };
    batches.push({
      tests,
      eligibleCases: tests.cases.filter(includes),
      includes,
    });
  }

  const hasOnly = batches.some((batch) =>
    batch.eligibleCases.some((test) => test.modifiers.only),
  );
  let aggregate = emptySummary({ durationMs: 0 });
  for (const batch of batches) {
    const batchHasOnly = batch.eligibleCases.some(
      (test) => test.modifiers.only,
    );
    const summary =
      hasOnly && !batchHasOnly
        ? skipBatch({ cases: batch.eligibleCases, reporter })
        : await batch.tests.run({
            reporter: cliReporter,
            filter: batch.includes,
          });
    aggregate = addSummary(aggregate, summary);
  }

  const finalSummary = { ...aggregate, durationMs: Date.now() - startRun };
  if (finalSummary.total === 0) {
    return reportNoTestsFound({
      reporter,
      targetPath: scanRoot,
      failOnEmptyTests,
      durationMs: finalSummary.durationMs,
    });
  }

  reportSummary(finalSummary, reporter);

  if (finalSummary.failed > 0) {
    if (reporter !== "silent") {
      console.error(
        `[execution] ${finalSummary.failed} test(s) failed for target: ${scanRoot}`,
      );
    }
    process.exitCode = 1;
  }

  return finalSummary;
};
