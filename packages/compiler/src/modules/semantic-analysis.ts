import type { Diagnostic } from "../diagnostics/index.js";
import { diagnosticFromCode, DiagnosticError } from "../diagnostics/index.js";
import type { ModuleGraph, ModuleNode } from "./types.js";
import { modulePathToString } from "./path.js";
import {
  semanticsPipeline,
  type SemanticsPipelineResult,
} from "../semantics/pipeline.js";
import { ModuleExportTable } from "../semantics/modules.js";
import { createTypeArena } from "../semantics/typing/type-arena.js";
import { createEffectInterner, createEffectTable } from "../semantics/effects/effect-table.js";
import { getModuleSccGroups } from "./scc.js";

export type AnalyzeModuleSemanticsOptions = {
  graph: ModuleGraph;
  includeTests?: boolean;
  recoverFromTypingErrors?: boolean;
  previousSemantics?: ReadonlyMap<string, SemanticsPipelineResult>;
  changedModuleIds?: ReadonlySet<string>;
  isCancelled?: () => boolean;
};

export type AnalyzeModuleSemanticsResult = {
  semantics: Map<string, SemanticsPipelineResult>;
  diagnostics: Diagnostic[];
  recomputedModuleIds: readonly string[];
};

const SEMANTICS_ANALYSIS_CANCELLED_CODE = "VOYD_SEMANTICS_ANALYSIS_CANCELLED";

const createSemanticsAnalysisCancelledError = (): Error & { code: string } => {
  const error = new Error("semantics analysis cancelled") as Error & {
    code: string;
  };
  error.name = "SemanticsAnalysisCancelledError";
  error.code = SEMANTICS_ANALYSIS_CANCELLED_CODE;
  return error;
};

export const isSemanticsAnalysisCancelledError = (
  error: unknown,
): error is Error & { code: string } =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { code?: unknown }).code === SEMANTICS_ANALYSIS_CANCELLED_CODE;

const throwIfCancelled = (isCancelled: (() => boolean) | undefined): void => {
  if (!isCancelled?.()) {
    return;
  }

  throw createSemanticsAnalysisCancelledError();
};

export const analyzeModuleSemantics = ({
  graph,
  includeTests,
  recoverFromTypingErrors,
  previousSemantics,
  changedModuleIds,
  isCancelled,
}: AnalyzeModuleSemanticsOptions): AnalyzeModuleSemanticsResult => {
  const sccGroups = getModuleSccGroups({ graph });
  const semantics = new Map<string, SemanticsPipelineResult>();
  const exports = new Map<string, ModuleExportTable>();
  const diagnostics: Diagnostic[] = [];
  const recomputedModuleIds: string[] = [];
  const arena = createTypeArena();
  const effectInterner = createEffectInterner();

  const cycleModuleIdsByModuleId = new Map<string, readonly string[]>();
  sccGroups.forEach((group) => {
    if (!group.cyclic) return;
    group.moduleIds.forEach((moduleId) =>
      cycleModuleIdsByModuleId.set(moduleId, group.moduleIds),
    );
  });

  const incrementalModuleIds = resolveIncrementalModuleIds({
    graph,
    previousSemantics,
    changedModuleIds,
  });
  const isIncremental = incrementalModuleIds !== undefined;
  const recomputeSet = new Set(incrementalModuleIds ?? graph.modules.keys());

  if (isIncremental && previousSemantics) {
    graph.modules.forEach((_module, moduleId) => {
      if (recomputeSet.has(moduleId)) {
        return;
      }
      const cached = previousSemantics.get(moduleId);
      if (!cached) {
        return;
      }
      semantics.set(moduleId, cached);
      exports.set(moduleId, cached.exports);
      diagnostics.push(...cached.diagnostics);
    });
  }

  sccGroups.forEach((group) => {
    throwIfCancelled(isCancelled);

    const shouldRecomputeGroup = group.moduleIds.some((moduleId) =>
      recomputeSet.has(moduleId),
    );
    if (!shouldRecomputeGroup) {
      return;
    }

    group.moduleIds.forEach((moduleId) => {
      semantics.delete(moduleId);
      exports.delete(moduleId);
    });
    recomputedModuleIds.push(...group.moduleIds);

    const moduleId = group.moduleIds[0];
    if (!moduleId) {
      return;
    }

    if (group.cyclic) {
      analyzeCyclicScc({
        moduleIds: group.moduleIds,
        includeTests,
        recoverFromTypingErrors,
        cycleModuleIdsByModuleId,
        graph,
        semantics,
        exports,
        diagnostics,
        arena,
        effectInterner,
        isCancelled,
      });
      return;
    }

    const result = analyzeModule({
      moduleId,
      includeTests,
      recoverFromTypingErrors,
      cycleModuleIdsByModuleId,
      graph,
      semantics,
      exports,
      arena,
      effectInterner,
      diagnostics,
      isCancelled,
    });
    if (!result) {
      return;
    }
    semantics.set(moduleId, result);
    exports.set(moduleId, result.exports);
  });

  return {
    semantics,
    diagnostics,
    recomputedModuleIds,
  };
};

const analyzeCyclicScc = ({
  moduleIds,
  includeTests,
  recoverFromTypingErrors,
  cycleModuleIdsByModuleId,
  graph,
  semantics,
  exports,
  diagnostics,
  arena,
  effectInterner,
  isCancelled,
}: {
  moduleIds: readonly string[];
  includeTests: boolean | undefined;
  recoverFromTypingErrors: boolean | undefined;
  cycleModuleIdsByModuleId: ReadonlyMap<string, readonly string[]>;
  graph: ModuleGraph;
  semantics: Map<string, SemanticsPipelineResult>;
  exports: Map<string, ModuleExportTable>;
  diagnostics: Diagnostic[];
  arena: ReturnType<typeof createTypeArena>;
  effectInterner: ReturnType<typeof createEffectInterner>;
  isCancelled: (() => boolean) | undefined;
}) => {
  const firstPassSemantics = new Map<string, SemanticsPipelineResult>();
  const firstPassExports = new Map<string, ModuleExportTable>();
  const secondPassSemantics = new Map<string, SemanticsPipelineResult>();
  const secondPassExports = new Map<string, ModuleExportTable>();

  moduleIds.forEach((moduleId) => {
    throwIfCancelled(isCancelled);

    const result = analyzeModule({
      moduleId,
      includeTests,
      recoverFromTypingErrors: true,
      cycleModuleIdsByModuleId,
      graph,
      semantics: mergeWithOverrides({ base: semantics, overrides: firstPassSemantics }),
      exports: mergeWithOverrides({ base: exports, overrides: firstPassExports }),
      arena,
      effectInterner,
      isCancelled,
    });
    if (!result) {
      return;
    }
    firstPassSemantics.set(moduleId, result);
    firstPassExports.set(moduleId, result.exports);
  });

  moduleIds.forEach((moduleId) => {
    throwIfCancelled(isCancelled);

    const result = analyzeModule({
      moduleId,
      includeTests,
      recoverFromTypingErrors,
      cycleModuleIdsByModuleId,
      graph,
      semantics: mergeWithOverrides({
        base: mergeWithOverrides({ base: semantics, overrides: firstPassSemantics }),
        overrides: secondPassSemantics,
      }),
      exports: mergeWithOverrides({
        base: mergeWithOverrides({ base: exports, overrides: firstPassExports }),
        overrides: secondPassExports,
      }),
      arena,
      effectInterner,
      diagnostics,
      isCancelled,
    });
    if (!result) {
      return;
    }
    secondPassSemantics.set(moduleId, result);
    secondPassExports.set(moduleId, result.exports);
    semantics.set(moduleId, result);
    exports.set(moduleId, result.exports);
  });
};

const analyzeModule = ({
  moduleId,
  includeTests,
  recoverFromTypingErrors,
  cycleModuleIdsByModuleId,
  graph,
  semantics,
  exports,
  arena,
  effectInterner,
  diagnostics,
  isCancelled,
}: {
  moduleId: string;
  includeTests: boolean | undefined;
  recoverFromTypingErrors: boolean | undefined;
  cycleModuleIdsByModuleId: ReadonlyMap<string, readonly string[]>;
  graph: ModuleGraph;
  semantics: Map<string, SemanticsPipelineResult>;
  exports: Map<string, ModuleExportTable>;
  arena: ReturnType<typeof createTypeArena>;
  effectInterner: ReturnType<typeof createEffectInterner>;
  diagnostics?: Diagnostic[];
  isCancelled: (() => boolean) | undefined;
}): SemanticsPipelineResult | undefined => {
  throwIfCancelled(isCancelled);

  const module = graph.modules.get(moduleId);
  if (!module) {
    return undefined;
  }

  try {
    const result = semanticsPipeline({
      module,
      graph,
      exports,
      dependencies: semantics,
      typing: { arena, effects: createEffectTable({ interner: effectInterner }) },
      includeTests,
      recoverFromTypingErrors,
    });
    diagnostics?.push(
      ...augmentCycleTy0022Diagnostics({
        diagnostics: result.diagnostics,
        moduleId,
        cycleModuleIdsByModuleId,
      }),
    );
    return result;
  } catch (error) {
    if (isSemanticsAnalysisCancelledError(error)) {
      throw error;
    }

    if (error instanceof DiagnosticError) {
      diagnostics?.push(
        ...augmentCycleTy0022Diagnostics({
          diagnostics: error.diagnostics,
          moduleId,
          cycleModuleIdsByModuleId,
        }),
      );
      return undefined;
    }
    diagnostics?.push(
      diagnosticFromCode({
        code: "TY9999",
        params: {
          kind: "unexpected-error",
          message: error instanceof Error ? error.message : String(error),
        },
        span: { file: moduleDiagnosticFilePath(module), start: 0, end: 0 },
      }),
    );
    return undefined;
  }
};

const mergeWithOverrides = <K, V>({
  base,
  overrides,
}: {
  base: ReadonlyMap<K, V>;
  overrides: ReadonlyMap<K, V>;
}): Map<K, V> => new Map([...base.entries(), ...overrides.entries()]);

const augmentCycleTy0022Diagnostics = ({
  diagnostics,
  moduleId,
  cycleModuleIdsByModuleId,
}: {
  diagnostics: readonly Diagnostic[];
  moduleId: string;
  cycleModuleIdsByModuleId: ReadonlyMap<string, readonly string[]>;
}): Diagnostic[] => {
  const cycleModuleIds = cycleModuleIdsByModuleId.get(moduleId);
  if (!cycleModuleIds) {
    return [...diagnostics];
  }

  const cycleHintMessage = `Lookup happened inside import cycle: ${cycleModuleIds.join(", ")}. Method surfaces from cyclic dependencies may require a second typing pass.`;

  return diagnostics.map((diagnostic) => {
    if (diagnostic.code !== "TY0022") {
      return diagnostic;
    }
    const hints = diagnostic.hints ?? [];
    if (hints.some((hint) => hint.message === cycleHintMessage)) {
      return diagnostic;
    }
    return {
      ...diagnostic,
      hints: [...hints, { message: cycleHintMessage }],
    };
  });
};

const moduleDiagnosticFilePath = (module: ModuleNode): string =>
  module.ast.location?.filePath ??
  (module.origin.kind === "file" ? module.origin.filePath : module.id);

const resolveIncrementalModuleIds = ({
  graph,
  previousSemantics,
  changedModuleIds,
}: {
  graph: ModuleGraph;
  previousSemantics: ReadonlyMap<string, SemanticsPipelineResult> | undefined;
  changedModuleIds: ReadonlySet<string> | undefined;
}): Set<string> | undefined => {
  if (!previousSemantics) {
    return undefined;
  }

  const currentModuleIds = new Set(graph.modules.keys());
  const previousModuleIds = new Set(previousSemantics.keys());

  if (
    currentModuleIds.size !== previousModuleIds.size ||
    Array.from(currentModuleIds).some((moduleId) => !previousModuleIds.has(moduleId))
  ) {
    return undefined;
  }

  if (!changedModuleIds || changedModuleIds.size === 0) {
    return new Set();
  }

  const unknownChange = Array.from(changedModuleIds).some(
    (moduleId) => !currentModuleIds.has(moduleId),
  );
  if (unknownChange) {
    return undefined;
  }

  return collectReverseDependencyClosure({
    graph,
    seedModuleIds: changedModuleIds,
  });
};

const collectReverseDependencyClosure = ({
  graph,
  seedModuleIds,
}: {
  graph: ModuleGraph;
  seedModuleIds: ReadonlySet<string>;
}): Set<string> => {
  const reverseDependencies = buildReverseDependencies({ graph });
  const visited = new Set<string>();
  const queue = Array.from(seedModuleIds);

  while (queue.length > 0) {
    const next = queue.shift();
    if (!next || visited.has(next)) {
      continue;
    }

    visited.add(next);
    (reverseDependencies.get(next) ?? []).forEach((dependent) => {
      if (!visited.has(dependent)) {
        queue.push(dependent);
      }
    });
  }

  return visited;
};

const buildReverseDependencies = ({
  graph,
}: {
  graph: ModuleGraph;
}): Map<string, Set<string>> => {
  const reverseDependencies = new Map<string, Set<string>>();

  graph.modules.forEach((moduleNode, moduleId) => {
    moduleNode.dependencies.forEach((dependency) => {
      const dependencyId = modulePathToString(dependency.path);
      if (!graph.modules.has(dependencyId)) {
        return;
      }
      const dependents = reverseDependencies.get(dependencyId) ?? new Set<string>();
      dependents.add(moduleId);
      reverseDependencies.set(dependencyId, dependents);
    });
  });

  return reverseDependencies;
};
