import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parse } from "@voyd/compiler/parser/parser.js";
import { isForm } from "@voyd/compiler/parser/index.js";
import type { Form } from "@voyd/compiler/parser/index.js";
import type { TestAttribute } from "@voyd/compiler/parser/attributes.js";
import {
  analyzeModules,
  emitProgram,
  loadModuleGraph,
} from "@voyd/compiler/pipeline.js";
import type { Diagnostic } from "@voyd/compiler/diagnostics/index.js";
import { DiagnosticError } from "@voyd/compiler/diagnostics/index.js";
import {
  modulePathFromFile,
  modulePathToString,
} from "@voyd/compiler/modules/path.js";
import type { ModuleRoots } from "@voyd/compiler/modules/types.js";
import {
  runEffectfulExport,
  parseEffectTable,
  type EffectHandler,
} from "@voyd/compiler/codegen/effects/host-runner.js";
import type { EffectTableEffect } from "@voyd/compiler/codegen/effects/effect-table-types.js";
import { resolveStdRoot } from "@voyd/lib/resolve-std.js";
import { getWasmInstance } from "@voyd/lib/wasm.js";

type TestModifiers = {
  skip: boolean;
  only: boolean;
};

type DiscoveredTest = {
  filePath: string;
  fnName: string;
  description?: string;
  modifiers: TestModifiers;
  location?: {
    filePath: string;
    startLine: number;
    startColumn: number;
  };
};

type PlannedTest = DiscoveredTest & {
  moduleLabel: string;
  displayName: string;
  status: "pending" | "skipped";
  skipReason?: string;
};

type TestResult = Omit<PlannedTest, "status"> & {
  status: "passed" | "failed" | "skipped";
  durationMs: number;
  error?: unknown;
};

type TestRunSummary = {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
};

class TestFailure extends Error {
  constructor() {
    super("Test failed");
    this.name = "TestFailure";
  }
}

class TestSkip extends Error {
  constructor() {
    super("Test skipped");
    this.name = "TestSkip";
  }
}

type TestOpKind = "fail" | "skip" | "log";

const TEST_OP_HANDLERS: Record<TestOpKind, EffectHandler> = {
  fail: () => {
    throw new TestFailure();
  },
  skip: () => {
    throw new TestSkip();
  },
  log: () => null,
};

const testOpKind = (label: string): TestOpKind | undefined => {
  if (label.endsWith(".fail")) return "fail";
  if (label.endsWith(".skip")) return "skip";
  if (label.endsWith(".log")) return "log";
  return undefined;
};

const isTestEffect = (effect: EffectTableEffect): boolean =>
  effect.ops.some((op) => op.label.endsWith(".fail")) &&
  effect.ops.some((op) => op.label.endsWith(".skip")) &&
  effect.ops.some((op) => op.label.endsWith(".log"));

const buildTestEffectHandlers = (
  wasm: Uint8Array
): Record<string, EffectHandler> => {
  const table = parseEffectTable(wasm);
  const effect = table.effects.find(isTestEffect);
  if (!effect) return {};

  const handlers: Record<string, EffectHandler> = {};
  effect.ops.forEach((op) => {
    const kind = testOpKind(op.label);
    if (!kind) return;
    handlers[`${effect.id}:${op.id}:${op.resumeKind}`] = TEST_OP_HANDLERS[kind];
  });
  return handlers;
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

const parseTestsFromAst = (ast: Form, filePath: string): DiscoveredTest[] => {
  if (!ast.callsInternal("ast")) {
    return [];
  }

  const tests: DiscoveredTest[] = [];

  ast.rest.forEach((entry) => {
    if (!isForm(entry)) return;
    const attributes = entry.attributes as { test?: TestAttribute } | undefined;
    const test = attributes?.test;
    if (!test) return;

    const modifiers = {
      skip: test.modifiers?.skip === true,
      only: test.modifiers?.only === true,
    };

    const location = entry.location
      ? {
          filePath: entry.location.filePath,
          startLine: entry.location.startLine,
          startColumn: entry.location.startColumn + 1,
        }
      : undefined;

    tests.push({
      filePath,
      fnName: test.id,
      description: test.description,
      modifiers,
      location,
    });
  });

  return tests;
};

const buildModuleLabel = (filePath: string, roots: ModuleRoots): string => {
  const modulePath = modulePathFromFile(filePath, roots);
  return modulePathToString(modulePath);
};

const buildDisplayName = (
  test: DiscoveredTest,
  moduleLabel: string
): string => {
  if (test.description) {
    return `${moduleLabel}::${test.description}`;
  }

  if (test.location) {
    return `${moduleLabel}::<${test.location.filePath}:${test.location.startLine}:${test.location.startColumn}>`;
  }

  return `${moduleLabel}::<${test.fnName}>`;
};

const hasErrorDiagnostics = (diagnostics: readonly Diagnostic[]): boolean =>
  diagnostics.some((diagnostic) => diagnostic.severity === "error");

const assertNoDiagnostics = (diagnostics: readonly Diagnostic[]): void => {
  const error = diagnostics.find(
    (diagnostic) => diagnostic.severity === "error"
  );
  if (error) {
    throw new DiagnosticError(error);
  }
};

const runPureTest = (wasm: Uint8Array, exportName: string): void => {
  const instance = getWasmInstance(wasm);
  const target = instance.exports[exportName];
  if (typeof target !== "function") {
    throw new Error(`Missing export ${exportName}`);
  }
  (target as CallableFunction)();
};

const runEffectfulTest = async (
  wasm: Uint8Array,
  exportName: string
): Promise<void> => {
  const handlers = buildTestEffectHandlers(wasm);
  await runEffectfulExport({
    wasm,
    entryName: `${exportName}_effectful`,
    handlers,
  });
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

const resolveRoots = (
  rootPath: string
): { scanRoot: string; roots: ModuleRoots } => {
  const resolved = resolve(rootPath);
  const scanRoot = resolved;
  const srcRoot = resolved.endsWith(".voyd") ? dirname(resolved) : resolved;
  return { scanRoot, roots: { src: srcRoot, std: resolveStdRoot() } };
};

export const runTests = async ({
  rootPath,
  reporter = "default",
}: {
  rootPath: string;
  reporter?: string;
}): Promise<TestRunSummary> => {
  const { scanRoot, roots } = resolveRoots(rootPath);
  const files = await findVoydFiles(scanRoot);

  const discovered: DiscoveredTest[] = [];
  for (const filePath of files) {
    const source = await readFile(filePath, "utf8");
    const ast = parse(source, filePath);
    discovered.push(...parseTestsFromAst(ast, filePath));
  }

  if (discovered.length === 0) {
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

  const hasOnly = discovered.some((test) => test.modifiers.only);
  const planned: PlannedTest[] = discovered.map((test) => {
    const moduleLabel = buildModuleLabel(test.filePath, roots);
    const displayName = buildDisplayName(test, moduleLabel);

    if (hasOnly && !test.modifiers.only) {
      return {
        ...test,
        moduleLabel,
        displayName,
        status: "skipped",
        skipReason: "only",
      };
    }

    if (test.modifiers.skip) {
      return {
        ...test,
        moduleLabel,
        displayName,
        status: "skipped",
        skipReason: "skip",
      };
    }

    return { ...test, moduleLabel, displayName, status: "pending" };
  });

  const byFile = new Map<string, PlannedTest[]>();
  const results: TestResult[] = [];

  planned.forEach((test) => {
    if (test.status === "skipped") {
      const result: TestResult = {
        ...test,
        status: "skipped",
        durationMs: 0,
      };
      results.push(result);
      reportResult(result, reporter);
      return;
    }

    const tests = byFile.get(test.filePath) ?? [];
    tests.push(test);
    byFile.set(test.filePath, tests);
  });

  const startRun = Date.now();

  for (const [filePath, tests] of byFile.entries()) {
    const graph = await loadModuleGraph({ entryPath: filePath, roots });
    const { semantics, diagnostics: semanticDiagnostics } = analyzeModules({
      graph,
      includeTests: true,
    });
    const diagnostics = [...graph.diagnostics, ...semanticDiagnostics];
    if (hasErrorDiagnostics(diagnostics)) {
      assertNoDiagnostics(diagnostics);
    }

    const { wasm, diagnostics: codegenDiagnostics } = await emitProgram({
      graph,
      semantics,
      codegenOptions: { testMode: true },
    });
    const allDiagnostics = [...diagnostics, ...codegenDiagnostics];
    if (hasErrorDiagnostics(allDiagnostics)) {
      assertNoDiagnostics(allDiagnostics);
    }

    const entrySemantics = semantics.get(graph.entry);
    if (!entrySemantics) {
      throw new Error("No semantics available for entry module");
    }

    for (const test of tests) {
      const start = Date.now();
      const fnDecl = entrySemantics.binding.functions.find(
        (fn) => fn.name === test.fnName
      );
      if (!fnDecl) {
        const error = new Error(`Missing test function ${test.fnName}`);
        const result: TestResult = {
          ...test,
          status: "failed",
          durationMs: Date.now() - start,
          error,
        };
        results.push(result);
        reportResult(result, reporter);
        continue;
      }

      const effectRow = entrySemantics.typing.effects.getFunctionEffect(
        fnDecl.symbol
      );
      const isEffectful =
        typeof effectRow === "number" &&
        !entrySemantics.typing.effects.isEmpty(effectRow);

      try {
        if (isEffectful) {
          await runEffectfulTest(wasm, test.fnName);
        } else {
          runPureTest(wasm, test.fnName);
        }
        const result: TestResult = {
          ...test,
          status: "passed",
          durationMs: Date.now() - start,
        };
        results.push(result);
        reportResult(result, reporter);
      } catch (error) {
        if (error instanceof TestSkip) {
          const result: TestResult = {
            ...test,
            status: "skipped",
            durationMs: Date.now() - start,
          };
          results.push(result);
          reportResult(result, reporter);
          continue;
        }

        const result: TestResult = {
          ...test,
          status: "failed",
          durationMs: Date.now() - start,
          error,
        };
        results.push(result);
        reportResult(result, reporter);
      }
    }
  }

  const summary: TestRunSummary = {
    total: results.length,
    passed: results.filter((r) => r.status === "passed").length,
    failed: results.filter((r) => r.status === "failed").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    durationMs: Date.now() - startRun,
  };

  reportSummary(summary, reporter);

  if (summary.failed > 0) {
    process.exitCode = 1;
  }

  return summary;
};
