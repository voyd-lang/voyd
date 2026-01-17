import { codegenErrorToDiagnostic } from "@voyd/compiler/codegen/diagnostics.js";
import type { Diagnostic } from "@voyd/compiler/diagnostics/index.js";
import { DiagnosticError } from "@voyd/compiler/diagnostics/index.js";
import type { ModuleHost, ModuleRoots } from "@voyd/compiler/modules/types.js";
import {
  analyzeModules,
  emitProgram,
  type LoadModuleGraphFn,
} from "@voyd/compiler/pipeline-shared.js";
import type { CompileResult } from "./types.js";

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
  loadModuleGraph,
}: {
  entryPath: string;
  roots: ModuleRoots;
  host?: ModuleHost;
  includeTests?: boolean;
  loadModuleGraph: LoadModuleGraphFn;
}): Promise<CompileResult> => {
  const graph = await loadModuleGraph({ entryPath, roots, host });
  const { semantics, diagnostics: semanticDiagnostics } = analyzeModules({
    graph,
    includeTests,
  });
  const diagnostics = [...graph.diagnostics, ...semanticDiagnostics];

  throwIfError(diagnostics);

  try {
    const wasmResult = await emitProgram({ graph, semantics });
    const allDiagnostics = [...diagnostics, ...wasmResult.diagnostics];
    throwIfError(allDiagnostics);
    return { wasm: wasmResult.wasm, diagnostics: allDiagnostics };
  } catch (error) {
    const diagnostic = codegenErrorToDiagnostic(error, {
      moduleId: graph.entry ?? entryPath,
    });
    throw new DiagnosticError(diagnostic);
  }
};
