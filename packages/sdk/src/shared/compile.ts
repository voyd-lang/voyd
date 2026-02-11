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
import { diagnosticsFromUnknownError } from "./diagnostics.js";

export type CompileArtifactsSuccess = {
  success: true;
  wasm: Uint8Array;
  wasmText?: string;
  tests?: readonly TestCase[];
  testsWasm?: Uint8Array;
};

export type CompileArtifactsFailure = {
  success: false;
  diagnostics: Diagnostic[];
};

export type CompileArtifacts = CompileArtifactsSuccess | CompileArtifactsFailure;

const hasErrorDiagnostics = (diagnostics: readonly Diagnostic[]): boolean =>
  diagnostics.some((diagnostic) => diagnostic.severity === "error");

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
  const shouldIncludeTests = includeTests || testsOnly;
  let graph: Awaited<ReturnType<LoadModuleGraphFn>>;
  try {
    graph = await loadModuleGraph({
      entryPath,
      roots,
      host,
      includeTests: shouldIncludeTests,
    });
  } catch (error) {
    return {
      success: false,
      diagnostics: diagnosticsFromUnknownError({
        error,
        fallbackFile: entryPath,
      }),
    };
  }

  const scopedTestScope = testScope ?? "all";
  const { semantics, diagnostics: semanticDiagnostics, tests } = analyzeModules({
    graph,
    includeTests: shouldIncludeTests,
    testScope: scopedTestScope,
  });
  const diagnostics = [...graph.diagnostics, ...semanticDiagnostics];
  const testCases = shouldIncludeTests ? tests : undefined;

  if (hasErrorDiagnostics(diagnostics)) {
    return {
      success: false,
      diagnostics,
    };
  }

  try {
    if (testsOnly) {
      const testResult = await emitProgram({
        graph,
        semantics,
        codegenOptions: { testMode: true, testScope: scopedTestScope },
      });
      const allDiagnostics = [...diagnostics, ...testResult.diagnostics];
      if (hasErrorDiagnostics(allDiagnostics)) {
        return { success: false, diagnostics: allDiagnostics };
      }

      return {
        success: true,
        wasm: testResult.wasm,
        tests: testCases,
        testsWasm: testResult.wasm,
      };
    }

    const wasmResult = await emitProgram({ graph, semantics });
    const baseDiagnostics = [...diagnostics, ...wasmResult.diagnostics];
    if (hasErrorDiagnostics(baseDiagnostics)) {
      return { success: false, diagnostics: baseDiagnostics };
    }

    let testsWasm: Uint8Array | undefined;

    if (shouldIncludeTests && tests.length > 0) {
      const testResult = await emitProgram({
        graph,
        semantics,
        codegenOptions: { testMode: true, testScope: scopedTestScope },
      });
      const allDiagnostics = [...baseDiagnostics, ...testResult.diagnostics];
      if (hasErrorDiagnostics(allDiagnostics)) {
        return { success: false, diagnostics: allDiagnostics };
      }
      testsWasm = testResult.wasm;
    }

    return {
      success: true,
      wasm: wasmResult.wasm,
      tests: testCases,
      testsWasm,
    };
  } catch (error) {
    const codegenDiagnostics =
      error instanceof DiagnosticError
        ? error.diagnostics
        : [
            codegenErrorToDiagnostic(error, {
              moduleId: graph.entry ?? entryPath,
            }),
          ];
    return {
      success: false,
      diagnostics: [...diagnostics, ...codegenDiagnostics],
    };
  }
};
