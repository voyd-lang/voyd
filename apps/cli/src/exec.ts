import { stdout } from "process";
import { readFileSync, statSync, existsSync } from "fs";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { CompileResult } from "@voyd/sdk";
import type { Diagnostic, HirGraph, ModuleRoots } from "@voyd/sdk/compiler";
import type { DocumentationOutputFormat } from "@voyd/sdk/doc-generation";
import { formatCliDiagnostic } from "./diagnostics.js";
import { printJson, printValue } from "./output.js";
import { getConfig } from "./config/index.js";
import {
  compactDiagnosticsForCli,
  formatCompactionSummary,
} from "./diagnostic-compaction.js";

export const exec = () => main().catch(errorHandler);

type VoydSdk = ReturnType<(typeof import("@voyd/sdk"))["createSdk"]>;

let sdkPromise: Promise<VoydSdk> | undefined;

type TestFailurePhase = "discovery" | "typing" | "execution";

async function main() {
  const config = getConfig();
  if (config.test) {
    const { runTests } = await import("./test-runner.js");
    return runTests({
      rootPath: config.index,
      reporter: config.testReporter,
      failOnEmptyTests: config.failOnEmptyTests,
      pkgDirs: config.pkgDirs,
    });
  }

  const entryPath = config.runWasm
    ? resolve(config.index)
    : resolveEntryPath(config.index);

  if (config.runWasm) {
    return runWasm(entryPath, config.entry);
  }

  if (config.emitParserAst) {
    return printJson(await getParserAst(entryPath));
  }

  let rootsPromise: Promise<ModuleRoots> | undefined;
  const getRoots = () => {
    rootsPromise ??= getModuleRoots({
      entryPath,
      additionalPkgDirs: config.pkgDirs,
    });
    return rootsPromise;
  };

  if (config.doc) {
    return emitDocumentation({
      entryPath,
      roots: await getRoots(),
      outPath: config.docOut,
      format: config.docFormat,
    });
  }

  if (config.emitCoreAst) {
    return printJson(await getCoreAst(entryPath));
  }

  if (config.emitIrAst) {
    return printJson(await getIrAST(entryPath, await getRoots()));
  }

  if (config.emitWasmText) {
    return console.log(
      await getWasmText(
        entryPath,
        await getRoots(),
        config.runBinaryenOptimizationPass,
      ),
    );
  }

  if (config.emitWasm) {
    return emitWasm(
      entryPath,
      await getRoots(),
      config.runBinaryenOptimizationPass,
    );
  }

  if (config.run) {
    return runVoyd({
      entryPath,
      entryName: config.entry,
      roots: await getRoots(),
      optimize: config.runBinaryenOptimizationPass,
    });
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

const getModuleRoots = ({
  entryPath,
  additionalPkgDirs = [],
}: {
  entryPath: string;
  additionalPkgDirs?: readonly string[];
}): Promise<ModuleRoots> => {
  return loadModuleRoots({
    entryPath,
    additionalPkgDirs,
  });
};

const loadModuleRoots = async ({
  entryPath,
  additionalPkgDirs,
}: {
  entryPath: string;
  additionalPkgDirs: readonly string[];
}): Promise<ModuleRoots> => {
  const [{ detectSrcRootForPath }, { resolveStdRoot }, { resolvePackageDirs }] =
    await Promise.all([
      import("@voyd/sdk"),
      import("@voyd/lib/resolve-std.js"),
      import("./package-dirs.js"),
    ]);
  const srcRoot = detectSrcRootForPath(entryPath);
  return {
    src: srcRoot,
    std: resolveStdRoot(),
    pkgDirs: resolvePackageDirs({ srcRoot, additionalPkgDirs }),
  };
};

const getSdk = async (): Promise<VoydSdk> => {
  sdkPromise ??= import("@voyd/sdk").then(({ createSdk }) => createSdk());
  return sdkPromise;
};

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
  const { parse } = await import("@voyd/sdk/compiler");
  const file = readFileSync(entryPath, { encoding: "utf8" });
  return parse(file, entryPath).toJSON();
}

async function getCoreAst(entryPath: string) {
  return await getParserAst(entryPath);
}

async function getIrAST(entryPath: string, roots: ModuleRoots) {
  const { analyzeModules, loadModuleGraph } = await import("@voyd/sdk/compiler");
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

async function getWasmText(
  entryPath: string,
  roots: ModuleRoots,
  optimize = false,
) {
  const sdk = await getSdk();
  const result = requireCompileSuccess(
    await sdk.compile({
      entryPath,
      roots,
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

async function emitWasm(
  entryPath: string,
  roots: ModuleRoots,
  optimize = false,
) {
  const sdk = await getSdk();
  const result = requireCompileSuccess(
    await sdk.compile({ entryPath, roots, optimize }),
  );
  stdout.write(result.wasm);
}

async function runVoyd({
  entryPath,
  entryName = "main",
  roots,
  optimize = false,
}: {
  entryPath: string;
  entryName?: string;
  roots: ModuleRoots;
  optimize?: boolean;
}) {
  const sdk = await getSdk();
  const compiled = requireCompileSuccess(
    await sdk.compile({ entryPath, roots, optimize }),
  );

  const result = await sdk.run({ wasm: compiled.wasm, entryName });
  printValue(result);
}

async function runWasm(entryPath: string, entryName = "main") {
  const { createVoydHost } = await import("@voyd/sdk/js-host");
  const wasm = readFileSync(entryPath);
  const host = await createVoydHost({ wasm });
  const result = await host.run(entryName);
  printValue(result);
}

async function emitDocumentation({
  entryPath,
  roots,
  outPath,
  format,
}: {
  entryPath: string;
  roots: ModuleRoots;
  outPath?: string;
  format?: DocumentationOutputFormat;
}) {
  const { generateDocumentation } = await import("@voyd/sdk/doc-generation");
  const resolvedFormat = format ?? "html";
  const { content } = await generateDocumentation({
    entryPath,
    roots,
    format: resolvedFormat,
  });
  const defaultOut = resolvedFormat === "json" ? "docs.json" : "docs.html";
  const targetPath = resolve(outPath ?? defaultOut);
  await writeFile(targetPath, content, "utf8");
  console.log(targetPath);
}

function errorHandler(error: unknown) {
  const diagnostics = extractDiagnostics(error);
  if (diagnostics) {
    const testFailure = extractTestFailure(error);
    if (testFailure) {
      console.error(
        `[${testFailure.phase}] voyd test failed for target: ${testFailure.targetPath}`,
      );
      console.error("");
    }

    const compacted = compactDiagnosticsForCli(diagnostics);

    compacted.diagnostics.forEach((diagnostic, index) => {
      if (index > 0) {
        console.error("");
      }
      console.error(formatCliDiagnostic(diagnostic));
    });

    const summary = formatCompactionSummary(compacted);
    if (summary) {
      if (compacted.diagnostics.length > 0) {
        console.error("");
      }
      console.error(summary);
    }

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

const extractTestFailure = (
  error: unknown,
): { phase: TestFailurePhase; targetPath: string } | undefined => {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const candidate = error as { testPhase?: unknown; testTargetPath?: unknown };
  const phase = candidate.testPhase;
  const targetPath = candidate.testTargetPath;
  if (
    (phase === "discovery" || phase === "typing" || phase === "execution") &&
    typeof targetPath === "string"
  ) {
    return { phase, targetPath };
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
