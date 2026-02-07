import { stdout } from "process";
import { readFileSync, statSync, existsSync } from "fs";
import { dirname, join, resolve } from "node:path";
import { getConfig } from "@voyd/lib/config/index.js";
import { resolveStdRoot } from "@voyd/lib/resolve-std.js";
import { testGc } from "@voyd/lib/binaryen-gc/test.js";
import { createSdk, type CompileResult } from "@voyd/sdk";
import {
  analyzeModules,
  loadModuleGraph,
  parse,
} from "@voyd/sdk/compiler";
import type { Diagnostic, HirGraph } from "@voyd/sdk/compiler";
import { formatCliDiagnostic } from "./diagnostics.js";
import { printJson, printValue } from "./output.js";
import { runTests } from "./test-runner.js";

export const exec = () => main().catch(errorHandler);

const sdk = createSdk();

async function main() {
  const config = getConfig();
  if (config.test) {
    return runTests({
      rootPath: config.index,
      reporter: config.testReporter,
      failOnEmptyTests: config.failOnEmptyTests,
    });
  }

  const entryPath = resolveEntryPath(config.index);

  if (config.emitParserAst) {
    return printJson(await getParserAst(entryPath));
  }

  if (config.emitCoreAst) {
    return printJson(await getCoreAst(entryPath));
  }

  if (config.emitIrAst) {
    return printJson(await getIrAST(entryPath));
  }

  if (config.emitWasmText) {
    return console.log(
      await getWasmText(entryPath, config.runBinaryenOptimizationPass),
    );
  }

  if (config.emitWasm) {
    return emitWasm(entryPath, config.runBinaryenOptimizationPass);
  }

  if (config.run) {
    return runWasm(entryPath, config.runBinaryenOptimizationPass);
  }

  if (config.internalTest) {
    return testGc();
  }

  console.log(
    "I don't know what to do with the supplied options. Maybe try something else ¯_(ツ)_/¯",
  );
}

const resolveEntryPath = (index: string): string => {
  const resolved = resolve(index);
  let stats: ReturnType<typeof statSync>;

  try {
    stats = statSync(resolved);
  } catch {
    return resolved;
  }

  if (!stats.isDirectory()) {
    return resolved;
  }

  const mainEntry = join(resolved, "main.voyd");
  if (existsSync(mainEntry)) return mainEntry;

  const packageEntry = join(resolved, "pkg.voyd");
  if (existsSync(packageEntry)) return packageEntry;

  throw new Error(
    `No entry file found in ${resolved}. Expected main.voyd or pkg.voyd.`,
  );
};

const getModuleRoots = (entryPath: string) => ({
  src: dirname(entryPath),
  std: resolveStdRoot(),
});

const failWithDiagnostics = (diagnostics: readonly Diagnostic[]): never => {
  throw { diagnostics: [...diagnostics] };
};

const requireCompileSuccess = (
  result: CompileResult,
): Extract<CompileResult, { success: true }> => {
  if (!result.success) {
    failWithDiagnostics(result.diagnostics);
  }
  return result as Extract<CompileResult, { success: true }>;
};

const assertNoDiagnostics = (diagnostics: readonly Diagnostic[]): void => {
  const hasErrors = diagnostics.some(
    (diagnostic) => diagnostic.severity === "error",
  );
  if (hasErrors) {
    failWithDiagnostics(diagnostics);
  }
};

const serializeHir = (hir: HirGraph) => ({
  module: hir.module,
  items: Array.from(hir.items.entries()),
  statements: Array.from(hir.statements.entries()),
  expressions: Array.from(hir.expressions.entries()),
});

async function getParserAst(entryPath: string) {
  const file = readFileSync(entryPath, { encoding: "utf8" });
  return parse(file, entryPath).toJSON();
}

async function getCoreAst(entryPath: string) {
  return await getParserAst(entryPath);
}

async function getIrAST(entryPath: string) {
  const roots = getModuleRoots(entryPath);
  const graph = await loadModuleGraph({ entryPath, roots });
  const { semantics, diagnostics: semanticDiagnostics } = analyzeModules({
    graph,
  });
  const diagnostics = [...graph.diagnostics, ...semanticDiagnostics];

  assertNoDiagnostics(diagnostics);

  const entrySemantics = semantics.get(graph.entry);
  if (!entrySemantics) {
    throw new Error("No semantics available for entry module");
  }

  return serializeHir(entrySemantics.hir);
}

async function getWasmText(entryPath: string, optimize = false) {
  const result = requireCompileSuccess(
    await sdk.compile({
      entryPath,
      optimize,
      emitWasmText: true,
    }),
  );

  const { wasmText } = result;
  if (!wasmText) {
    throw new Error("Wasm text output was not produced");
  }
  return wasmText;
}

async function emitWasm(entryPath: string, optimize = false) {
  const result = requireCompileSuccess(
    await sdk.compile({ entryPath, optimize }),
  );
  stdout.write(result.wasm);
}

async function runWasm(entryPath: string, optimize = false) {
  const compiled = requireCompileSuccess(
    await sdk.compile({ entryPath, optimize }),
  );

  const result = await sdk.run({ wasm: compiled.wasm, entryName: "main" });
  printValue(result);
}

function errorHandler(error: unknown) {
  const diagnostics = extractDiagnostics(error);
  if (diagnostics) {
    diagnostics.forEach((diagnostic, index) => {
      if (index > 0) {
        console.error("");
      }
      console.error(formatCliDiagnostic(diagnostic));
    });
    process.exit(1);
  }

  console.error(error);
  process.exit(1);
}

const extractDiagnostics = (error: unknown): Diagnostic[] | undefined => {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  if ("diagnostics" in error) {
    const values = (error as { diagnostics?: unknown }).diagnostics;
    if (!Array.isArray(values)) {
      return undefined;
    }

    const diagnostics = values.filter((value): value is Diagnostic =>
      isDiagnostic(value),
    );
    return diagnostics.length > 0 ? diagnostics : undefined;
  }

  if ("diagnostic" in error) {
    const candidate = (error as { diagnostic?: unknown }).diagnostic;
    return isDiagnostic(candidate) ? [candidate] : undefined;
  }

  return undefined;
};

const isDiagnostic = (value: unknown): value is Diagnostic => {
  if (!value || typeof value !== "object") {
    return false;
  }

  const diagnostic = value as Partial<Diagnostic>;
  const span = diagnostic.span as
    | { file?: unknown; start?: unknown; end?: unknown }
    | undefined;

  if (!span) {
    return false;
  }

  const hasRequiredFields =
    typeof diagnostic.code === "string" &&
    typeof diagnostic.message === "string" &&
    typeof span.file === "string" &&
    typeof span.start === "number" &&
    typeof span.end === "number";

  return hasRequiredFields;
};
