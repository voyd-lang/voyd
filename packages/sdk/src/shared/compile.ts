import { codegenErrorToDiagnostic } from "@voyd/compiler/codegen/diagnostics.js";
import type { Diagnostic } from "@voyd/compiler/diagnostics/index.js";
import { DiagnosticError } from "@voyd/compiler/diagnostics/index.js";
import type { ModuleHost, ModuleRoots } from "@voyd/compiler/modules/types.js";
import {
  analyzeModules,
  emitProgram,
  type LoadModuleGraphFn,
  type TestScope,
} from "@voyd/compiler/pipeline-shared.js";
import type { TestCase } from "./types.js";

export type CompileArtifacts = {
  wasm: Uint8Array;
  wasmText?: string;
  diagnostics: Diagnostic[];
  tests?: readonly TestCase[];
  testsWasm?: Uint8Array;
};

const throwIfError = (diagnostics: Diagnostic[]): void => {
  const error = diagnostics.find((diagnostic) => diagnostic.severity === "error");
  if (!error) return;
  throw new DiagnosticError(error);
};

export const compileWithLoader = async ({
  entryPath,
  roots,
  host,
  includeTests,
  testsOnly,
  loadModuleGraph,
  testScope,
}: {
  entryPath: string;
  roots: ModuleRoots;
  host?: ModuleHost;
  includeTests?: boolean;
  testsOnly?: boolean;
  loadModuleGraph: LoadModuleGraphFn;
  testScope?: TestScope;
}): Promise<CompileArtifacts> => {
  const graph = await loadModuleGraph({ entryPath, roots, host });
  const shouldIncludeTests = includeTests || testsOnly;
  const scopedTestScope = testScope ?? "all";
  const { semantics, diagnostics: semanticDiagnostics, tests } = analyzeModules({
    graph,
    includeTests: shouldIncludeTests,
    testScope: scopedTestScope,
  });
  const diagnostics = [...graph.diagnostics, ...semanticDiagnostics];
  const testCases = shouldIncludeTests ? tests : undefined;

  throwIfError(diagnostics);

  try {
    if (testsOnly) {
      const testResult = await emitProgram({
        graph,
        semantics,
        codegenOptions: { testMode: true, testScope: scopedTestScope },
      });
      const allDiagnostics = [...diagnostics, ...testResult.diagnostics];
      throwIfError(allDiagnostics);
      return {
        wasm: testResult.wasm,
        diagnostics: allDiagnostics,
        tests: testCases,
        testsWasm: testResult.wasm,
      };
    }

    const wasmResult = await emitProgram({ graph, semantics });
    const baseDiagnostics = [...diagnostics, ...wasmResult.diagnostics];
    throwIfError(baseDiagnostics);

    let testsWasm: Uint8Array | undefined;
    let allDiagnostics = baseDiagnostics;

    if (shouldIncludeTests && tests.length > 0) {
      const testResult = await emitProgram({
        graph,
        semantics,
        codegenOptions: { testMode: true, testScope: scopedTestScope },
      });
      allDiagnostics = [...baseDiagnostics, ...testResult.diagnostics];
      throwIfError(allDiagnostics);
      testsWasm = testResult.wasm;
    }

    return {
      wasm: wasmResult.wasm,
      diagnostics: allDiagnostics,
      tests: testCases,
      testsWasm,
    };
  } catch (error) {
    const diagnostic = codegenErrorToDiagnostic(error, {
      moduleId: graph.entry ?? entryPath,
    });
    throw new DiagnosticError(diagnostic);
  }
};
