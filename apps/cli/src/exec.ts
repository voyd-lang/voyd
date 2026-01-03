import { stdout } from "process";
import { readFileSync, statSync, existsSync } from "fs";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import binaryen from "binaryen";
import { getConfig } from "@voyd/lib/config/index.js";
import { testGc } from "@voyd/lib/binaryen-gc/test.js";
import { parse } from "@voyd/compiler/parser/parser.js";
import {
  analyzeModules,
  emitProgram,
  loadModuleGraph,
} from "@voyd/compiler/pipeline.js";
import { getWasmInstance } from "@voyd/lib/wasm.js";
import type { HirGraph } from "@voyd/compiler/semantics/hir/index.js";
import type { Diagnostic } from "@voyd/compiler/diagnostics/index.js";
import { DiagnosticError } from "@voyd/compiler/diagnostics/index.js";
import { formatCliDiagnostic } from "./diagnostics.js";
import { assertRunnableWasm, emitWasmBytes } from "./wasm-validation.js";

export const exec = () => main().catch(errorHandler);

const require = createRequire(import.meta.url);

async function main() {
  const config = getConfig();
  const entryPath = resolveEntryPath(config.index);

  if (config.emitParserAst) {
    return emit(await getParserAst(entryPath));
  }

  if (config.emitCoreAst) {
    return emit(await getCoreAst(entryPath));
  }

  if (config.emitIrAst) {
    return emit(await getIrAST(entryPath));
  }

  if (config.emitWasmText) {
    return console.log(
      await getWasmText(entryPath, config.runBinaryenOptimizationPass)
    );
  }

  if (config.emitWasm) {
    return emitWasm(entryPath, config.runBinaryenOptimizationPass);
  }

  if (config.run) {
    return runWasm(
      entryPath,
      config.runBinaryenOptimizationPass,
      config.decodeMsgPackResponse
    );
  }

  if (config.internalTest) {
    return testGc();
  }

  console.log(
    "I don't know what to do with the supplied options. Maybe try something else ¯_(ツ)_/¯"
  );
}

const resolveStdRoot = (): string => {
  const pkgPath = require.resolve("@voyd/std/package.json");
  return dirname(pkgPath);
};

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
    `No entry file found in ${resolved}. Expected main.voyd or pkg.voyd.`
  );
};

const getModuleRoots = (entryPath: string) => ({
  src: dirname(entryPath),
  std: resolveStdRoot(),
});

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

const emitBinary = (mod: binaryen.Module): Uint8Array => emitWasmBytes(mod);

const compileModule = async (entryPath: string, optimize = false) => {
  const roots = getModuleRoots(entryPath);
  const graph = await loadModuleGraph({ entryPath, roots });
  const { semantics, diagnostics: semanticDiagnostics } = analyzeModules({
    graph,
  });
  const diagnostics = [...graph.diagnostics, ...semanticDiagnostics];

  if (hasErrorDiagnostics(diagnostics)) {
    assertNoDiagnostics(diagnostics);
  }

  const { module } = await emitProgram({ graph, semantics });

  if (optimize) {
    binaryen.setShrinkLevel(3);
    binaryen.setOptimizeLevel(3);
    module.optimize();
  }

  return module;
};

async function getWasmText(entryPath: string, optimize = false) {
  const mod = await compileModule(entryPath, optimize);
  return mod.emitText();
}

async function emitWasm(entryPath: string, optimize = false) {
  const mod = await compileModule(entryPath, optimize);

  const wasm = assertRunnableWasm(mod);
  stdout.write(wasm);
}

async function runWasm(
  entryPath: string,
  optimize = false,
  _decodeMsgPack = false
) {
  const mod = await compileModule(entryPath, optimize);

  const wasm = assertRunnableWasm(mod);
  const instance = getWasmInstance(wasm);
  const main = instance.exports.main;
  if (typeof main !== "function") {
    throw new Error("No main function exported from wasm module");
  }

  const result = main();
  console.log(result);
}

function emit(json: any) {
  console.log(JSON.stringify(json, undefined, 2));
}

function errorHandler(error: unknown) {
  const diagnostic = extractDiagnostic(error);
  if (diagnostic) {
    console.error(formatCliDiagnostic(diagnostic));
    process.exit(1);
  }

  console.error(error);
  process.exit(1);
}

const extractDiagnostic = (error: unknown): Diagnostic | undefined => {
  if (error instanceof DiagnosticError) {
    return error.diagnostic;
  }

  if (!error || typeof error !== "object" || !("diagnostic" in error)) {
    return undefined;
  }

  const candidate = (error as { diagnostic?: unknown }).diagnostic;
  return isDiagnostic(candidate) ? candidate : undefined;
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
