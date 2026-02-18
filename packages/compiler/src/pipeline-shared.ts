import type binaryen from "binaryen";
import { modulePathToString } from "./modules/path.js";
import type {
  ModuleGraph,
  ModuleHost,
  ModulePath,
  ModuleRoots,
} from "./modules/types.js";
import type { TestAttribute } from "./parser/attributes.js";
import { type SemanticsPipelineResult } from "./semantics/pipeline.js";
import { monomorphizeProgram } from "./semantics/linking.js";
import type { Diagnostic } from "./diagnostics/index.js";
import { diagnosticFromCode, DiagnosticError } from "./diagnostics/index.js";
import { codegenErrorToDiagnostic } from "./codegen/diagnostics.js";
import type { CodegenOptions } from "./codegen/context.js";
import type { ContinuationBackendKind } from "./codegen/codegen.js";
import { buildProgramCodegenView } from "./semantics/codegen-view/index.js";
import { analyzeModuleSemantics } from "./modules/semantic-analysis.js";
import { formatTestExportName } from "./tests/exports.js";
import type { SourceSpan, SymbolId } from "./semantics/ids.js";
import { getSymbolTable } from "./semantics/_internal/symbol-table.js";
import { formatEffectRow } from "./semantics/effects/format.js";

export type LoadModulesOptions = {
  entryPath: string;
  roots: ModuleRoots;
  host?: ModuleHost;
  includeTests?: boolean;
};

export type AnalyzeModulesOptions = {
  graph: ModuleGraph;
  includeTests?: boolean;
  testScope?: TestScope;
  recoverFromTypingErrors?: boolean;
};

export type AnalyzeModulesResult = {
  semantics: Map<string, SemanticsPipelineResult>;
  diagnostics: Diagnostic[];
  tests: readonly TestCase[];
};

export type TestScope = "all" | "entry";

export type TestCase = {
  id: string;
  exportName?: string;
  moduleId: string;
  modulePath: string;
  description?: string;
  modifiers: { skip?: boolean; only?: boolean };
  location?: { filePath: string; startLine: number; startColumn: number };
  effectful: boolean;
};

export type LowerProgramOptions = {
  graph: ModuleGraph;
  semantics: Map<string, SemanticsPipelineResult>;
};

export type EmitProgramOptions = {
  graph: ModuleGraph;
  semantics: Map<string, SemanticsPipelineResult>;
  codegenOptions?: CodegenOptions;
  entryModuleId?: string;
  /**
   * Whether to run the semantics linking stage prior to codegen.
   * Defaults to true.
   */
  linkSemantics?: boolean;
};

export type CompileProgramOptions = LoadModulesOptions &
  Omit<EmitProgramOptions, "graph" | "semantics"> & {
    /**
     * Skip semantic analysis. Useful for tooling that only needs the module
     * graph. Defaults to false.
     */
    skipSemantics?: boolean;
  };

export type CompileProgramSuccessResult = {
  success: true;
  graph: ModuleGraph;
  semantics?: Map<string, SemanticsPipelineResult>;
  wasm?: Uint8Array;
};

export type CompileProgramFailureResult = {
  success: false;
  diagnostics: Diagnostic[];
};

export type CompileProgramResult =
  | CompileProgramSuccessResult
  | CompileProgramFailureResult;

export const analyzeModules = ({
  graph,
  includeTests,
  testScope,
  recoverFromTypingErrors,
}: AnalyzeModulesOptions): AnalyzeModulesResult => {
  const { semantics, diagnostics } = analyzeModuleSemantics({
    graph,
    includeTests,
    recoverFromTypingErrors,
  });

  diagnostics.push(...enforcePublicApiMethodEffectAnnotations({ semantics }));

  const tests = includeTests
    ? collectTests({ graph, semantics, scope: testScope ?? "all" })
    : [];
  return { semantics, diagnostics, tests };
};

const enforcePublicApiMethodEffectAnnotations = ({
  semantics,
}: {
  semantics: Map<string, SemanticsPipelineResult>;
}): Diagnostic[] => {
  const diagnostics: Diagnostic[] = [];

  const importTargetsByModule = new Map<
    string,
    ReadonlyMap<SymbolId, { moduleId: string; symbol: SymbolId }>
  >();

  const importTargetsFor = (
    moduleId: string,
  ): ReadonlyMap<SymbolId, { moduleId: string; symbol: SymbolId }> => {
    const cached = importTargetsByModule.get(moduleId);
    if (cached) return cached;
    const mod = semantics.get(moduleId);
    if (!mod) return new Map();
    const mapped = new Map<SymbolId, { moduleId: string; symbol: SymbolId }>();
    mod.binding.imports.forEach((entry) => {
      if (!entry.target) return;
      mapped.set(entry.local, entry.target);
    });
    importTargetsByModule.set(moduleId, mapped);
    return mapped;
  };

  const resolveImportedTarget = ({
    moduleId,
    symbol,
  }: {
    moduleId: string;
    symbol: SymbolId;
  }): { moduleId: string; symbol: SymbolId } => {
    const seen = new Set<string>();
    let currentModuleId = moduleId;
    let currentSymbol = symbol;

    while (true) {
      const key = `${currentModuleId}:${currentSymbol}`;
      if (seen.has(key)) return { moduleId: currentModuleId, symbol: currentSymbol };
      seen.add(key);

      const next = importTargetsFor(currentModuleId).get(currentSymbol);
      if (!next) return { moduleId: currentModuleId, symbol: currentSymbol };
      currentModuleId = next.moduleId;
      currentSymbol = next.symbol;
    }
  };

  const packageRoots = Array.from(semantics.entries()).filter(
    ([, entry]) => entry.binding.isPackageRoot,
  );

  packageRoots.forEach(([rootModuleId, root]) => {
    const rootSymbolTable = getSymbolTable(root);
    const packageId = root.binding.packageId;

    const exportedObjectTargets = new Set<string>();
    root.hir.module.exports.forEach((entry) => {
      if (entry.visibility.level !== "public") return;
      if (rootSymbolTable.getSymbol(entry.symbol).kind !== "type") return;
      const resolved = resolveImportedTarget({
        moduleId: rootModuleId,
        symbol: entry.symbol,
      });
      const targetModule = semantics.get(resolved.moduleId);
      if (!targetModule) return;
      if (targetModule.binding.packageId !== packageId) return;
      exportedObjectTargets.add(`${resolved.moduleId}:${resolved.symbol}`);
    });

    if (exportedObjectTargets.size === 0) return;

    const seen = new Set<string>();

    semantics.forEach((mod, moduleId) => {
      if (mod.binding.packageId !== packageId) return;

      const symbolTable = getSymbolTable(mod);

      const functionSpanFor = (symbol: SymbolId): SourceSpan => {
        for (const item of mod.hir.items.values()) {
          if (item.kind !== "function") continue;
          if (item.symbol === symbol) return item.span;
        }
        return mod.hir.module.span;
      };

      const effectInfoFor = (
        effectRow: number,
      ): { isPure: boolean; isPolymorphic: boolean; effectsText: string } => {
        try {
          const row = mod.typing.effects.getRow(effectRow);
          const isPure = mod.typing.effects.isEmpty(effectRow);
          return {
            isPure,
            isPolymorphic:
              !isPure && row.operations.length === 0 && Boolean(row.tailVar),
            effectsText: formatEffectRow(effectRow, mod.typing.effects),
          };
        } catch {
          return {
            isPure: false,
            isPolymorphic: false,
            effectsText: "unknown effects",
          };
        }
      };

      mod.typing.memberMetadata.forEach((metadata, symbol) => {
        if (!metadata.visibility?.api) return;
        if (typeof metadata.owner !== "number") return;

        const resolvedOwner = resolveImportedTarget({
          moduleId,
          symbol: metadata.owner,
        });
        if (!exportedObjectTargets.has(`${resolvedOwner.moduleId}:${resolvedOwner.symbol}`)) {
          return;
        }

        const signature = mod.typing.functions.getSignature(symbol);
        if (!signature) return;

        const { isPure, isPolymorphic, effectsText } = effectInfoFor(signature.effectRow);
        if (signature.annotatedEffects || isPure || isPolymorphic) return;

        const seenKey = `${moduleId}:${symbol}`;
        if (seen.has(seenKey)) return;
        seen.add(seenKey);

        const ownerName = symbolTable.getSymbol(metadata.owner).name;
        const memberName = symbolTable.getSymbol(symbol).name;

        diagnostics.push(
          diagnosticFromCode({
            code: "TY0016",
            params: {
              kind: "pkg-effect-annotation",
              functionName: `${ownerName}.${memberName}`,
              effects: effectsText,
            },
            span: functionSpanFor(symbol),
          }),
        );
      });
    });
  });

  return diagnostics;
};

const collectTests = ({
  graph,
  semantics,
  scope,
}: {
  graph: ModuleGraph;
  semantics: Map<string, SemanticsPipelineResult>;
  scope: TestScope;
}): TestCase[] => {
  const tests: TestCase[] = [];
  const entryId = graph.entry ?? semantics.keys().next().value;

  semantics.forEach((entry, moduleId) => {
    if (scope === "entry" && moduleId !== entryId) {
      return;
    }
    const moduleNode = graph.modules.get(moduleId);
    if (!moduleNode) {
      return;
    }

    const modulePath = modulePathToString(moduleNode.path);
    entry.binding.functions.forEach((fn) => {
      const attributes = fn.form?.attributes as
        | { test?: TestAttribute }
        | undefined;
      const test = attributes?.test;
      if (!test) {
        return;
      }

      const location = fn.form?.location;
      const effectRow = entry.typing.effects.getFunctionEffect(fn.symbol);
      const effectful =
        typeof effectRow === "number" &&
        !entry.typing.effects.isEmpty(effectRow);

      tests.push({
        id: test.id,
        exportName: formatTestExportName({ moduleId, testId: test.id }),
        moduleId,
        modulePath,
        description: test.description,
        modifiers: normalizeTestModifiers(test.modifiers),
        location: location
          ? {
              filePath: location.filePath,
              startLine: location.startLine,
              startColumn: location.startColumn + 1,
            }
          : undefined,
        effectful,
      });
    });
  });

  return tests;
};

const normalizeTestModifiers = (
  modifiers?: TestAttribute["modifiers"]
): { skip?: boolean; only?: boolean } => {
  if (!modifiers) {
    return {};
  }

  return {
    ...(modifiers.skip ? { skip: true } : {}),
    ...(modifiers.only ? { only: true } : {}),
  };
};

export const lowerProgram = ({
  graph,
  semantics,
}: LowerProgramOptions): {
  orderedModules: readonly string[];
  entry: string;
} => {
  const visited = new Set<string>();
  const order: string[] = [];
  const entryId = graph.entry ?? semantics.keys().next().value;

  const visit = (id?: string) => {
    if (!id) return;
    if (visited.has(id)) return;
    visited.add(id);
    const module = graph.modules.get(id);
    if (!module) return;
    module.dependencies.forEach((dep) => visit(moduleIdForPath(dep.path)));
    order.push(id);
  };

  visit(entryId);

  // Ensure we only include modules we have semantics for.
  const filteredOrder = order.filter((id) => semantics.has(id));

  return { orderedModules: filteredOrder, entry: entryId };
};

export const emitProgram = async ({
  graph,
  semantics,
  codegenOptions,
  entryModuleId,
  linkSemantics,
}: EmitProgramOptions): Promise<{
  wasm: Uint8Array;
  module: binaryen.Module;
  diagnostics: Diagnostic[];
}> => {
  const { orderedModules, entry } = lowerProgram({ graph, semantics });
  const targetModuleId = entryModuleId ?? entry;
  const modules = orderedModules
    .map((id) => semantics.get(id))
    .filter((value): value is SemanticsPipelineResult => Boolean(value));
  if (modules.length === 0) {
    throw new Error("No semantics available for codegen");
  }

  const codegen = await lazyCodegen();
  const monomorphized =
    linkSemantics !== false
      ? monomorphizeProgram({ modules, semantics })
      : { instances: [], moduleTyping: new Map() };
  const program = buildProgramCodegenView(modules, {
    instances: monomorphized.instances,
    moduleTyping: monomorphized.moduleTyping,
  });
  const result = codegen.codegenProgram({
    program,
    entryModuleId: targetModuleId,
    options: codegenOptions,
  });
  const binary = result.module.emitBinary();
  const wasm =
    binary instanceof Uint8Array
      ? binary
      : (binary as { binary?: Uint8Array; output?: Uint8Array }).output ??
        (binary as { binary?: Uint8Array }).binary ??
        new Uint8Array();
  return { wasm, module: result.module, diagnostics: result.diagnostics };
};

export type ContinuationFallbackBundle = {
  preferredKind: ContinuationBackendKind;
  preferredWasm: Uint8Array;
  fallbackWasm?: Uint8Array;
};

export const emitProgramWithContinuationFallback = async ({
  graph,
  semantics,
  codegenOptions,
  entryModuleId,
  linkSemantics,
}: EmitProgramOptions): Promise<ContinuationFallbackBundle> => {
  const { orderedModules, entry } = lowerProgram({ graph, semantics });
  const targetModuleId = entryModuleId ?? entry;
  const modules = orderedModules
    .map((id) => semantics.get(id))
    .filter((value): value is SemanticsPipelineResult => Boolean(value));
  if (modules.length === 0) {
    throw new Error("No semantics available for codegen");
  }

  const monomorphized =
    linkSemantics !== false
      ? monomorphizeProgram({ modules, semantics })
      : { instances: [], moduleTyping: new Map() };
  const program = buildProgramCodegenView(modules, {
    instances: monomorphized.instances,
    moduleTyping: monomorphized.moduleTyping,
  });

  const codegenImpl = await lazyCodegen();
  const { preferredKind, preferred, fallback } =
    codegenImpl.codegenProgramWithContinuationFallback({
      program,
      entryModuleId: targetModuleId,
      options: codegenOptions,
    });

  const toWasmBytes = (result: { module: binaryen.Module }): Uint8Array => {
    const binary = result.module.emitBinary();
    return binary instanceof Uint8Array
      ? binary
      : (binary as { binary?: Uint8Array; output?: Uint8Array }).output ??
          (binary as { binary?: Uint8Array }).binary ??
          new Uint8Array();
  };

  return {
    preferredKind,
    preferredWasm: toWasmBytes(preferred),
    fallbackWasm: fallback ? toWasmBytes(fallback) : undefined,
  };
};

export type LoadModuleGraphFn = (
  options: LoadModulesOptions
) => Promise<ModuleGraph>;

const hasErrorDiagnostics = (diagnostics: readonly Diagnostic[]): boolean =>
  diagnostics.some((diagnostic) => diagnostic.severity === "error");

const compileProgramFailure = (
  diagnostics: readonly Diagnostic[]
): CompileProgramFailureResult => ({
  success: false,
  diagnostics: [...diagnostics],
});

const compileProgramSuccess = (
  result: Omit<CompileProgramSuccessResult, "success">
): CompileProgramSuccessResult => ({
  success: true,
  ...result,
});

const diagnosticsFromUnexpectedError = ({
  error,
  moduleId,
}: {
  error: unknown;
  moduleId: string;
}): Diagnostic[] => {
  if (error instanceof DiagnosticError) {
    return [...error.diagnostics];
  }

  return [
    diagnosticFromCode({
      code: "TY9999",
      params: {
        kind: "unexpected-error",
        message: error instanceof Error ? error.message : String(error),
      },
      span: { file: moduleId, start: 0, end: 0 },
    }),
  ];
};

export const compileProgramWithLoader = async (
  options: CompileProgramOptions,
  loadModuleGraph: LoadModuleGraphFn
): Promise<CompileProgramResult> => {
  let graph: ModuleGraph;
  try {
    graph = await loadModuleGraph(options);
  } catch (error) {
    return compileProgramFailure(
      diagnosticsFromUnexpectedError({
        error,
        moduleId: options.entryPath,
      }),
    );
  }

  if (options.skipSemantics) {
    const diagnostics = [...graph.diagnostics];
    return hasErrorDiagnostics(diagnostics)
      ? compileProgramFailure(diagnostics)
      : compileProgramSuccess({ graph });
  }

  const { semantics, diagnostics: semanticDiagnostics } = analyzeModules({
    graph,
    includeTests: options.includeTests,
  });
  const diagnostics = [...graph.diagnostics, ...semanticDiagnostics];

  if (hasErrorDiagnostics(diagnostics)) {
    return compileProgramFailure(diagnostics);
  }

  const shouldLinkSemantics = options.linkSemantics !== false;

  try {
    const wasmResult = await emitProgram({
      graph,
      semantics,
      codegenOptions: options.codegenOptions,
      entryModuleId: options.entryModuleId,
      linkSemantics: shouldLinkSemantics,
    });

    diagnostics.push(...wasmResult.diagnostics);

    if (hasErrorDiagnostics(diagnostics)) {
      return compileProgramFailure(diagnostics);
    }

    return compileProgramSuccess({
      graph,
      semantics,
      wasm: wasmResult.wasm,
    });
  } catch (error) {
    return compileProgramFailure([
      ...diagnostics,
      codegenErrorToDiagnostic(error, {
        moduleId: options.entryModuleId ?? graph.entry,
      }),
    ]);
  }
};

const moduleIdForPath = (path: ModulePath): string => modulePathToString(path);

const lazyCodegen = async () =>
  (await import(
    "./codegen/codegen.js"
  )) as typeof import("./codegen/codegen.js");
