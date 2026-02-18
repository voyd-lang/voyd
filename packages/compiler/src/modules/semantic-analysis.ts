import type { Diagnostic } from "../diagnostics/index.js";
import { diagnosticFromCode, DiagnosticError } from "../diagnostics/index.js";
import type { ModuleGraph, ModuleNode } from "./types.js";
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
};

export type AnalyzeModuleSemanticsResult = {
  semantics: Map<string, SemanticsPipelineResult>;
  diagnostics: Diagnostic[];
};

export const analyzeModuleSemantics = ({
  graph,
  includeTests,
  recoverFromTypingErrors,
}: AnalyzeModuleSemanticsOptions): AnalyzeModuleSemanticsResult => {
  const sccGroups = getModuleSccGroups({ graph });
  const semantics = new Map<string, SemanticsPipelineResult>();
  const exports = new Map<string, ModuleExportTable>();
  const diagnostics: Diagnostic[] = [];
  const arena = createTypeArena();
  const effectInterner = createEffectInterner();

  const cycleModuleIdsByModuleId = new Map<string, readonly string[]>();
  sccGroups.forEach((group) => {
    if (!group.cyclic) return;
    group.moduleIds.forEach((moduleId) =>
      cycleModuleIdsByModuleId.set(moduleId, group.moduleIds),
    );
  });

  sccGroups.forEach((group) => {
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
    });
    if (!result) {
      return;
    }
    semantics.set(moduleId, result);
    exports.set(moduleId, result.exports);
  });

  return { semantics, diagnostics };
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
}) => {
  const firstPassSemantics = new Map<string, SemanticsPipelineResult>();
  const firstPassExports = new Map<string, ModuleExportTable>();

  moduleIds.forEach((moduleId) => {
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
    });
    if (!result) {
      return;
    }
    firstPassSemantics.set(moduleId, result);
    firstPassExports.set(moduleId, result.exports);
  });

  moduleIds.forEach((moduleId) => {
    const result = analyzeModule({
      moduleId,
      includeTests,
      recoverFromTypingErrors,
      cycleModuleIdsByModuleId,
      graph,
      semantics: mergeWithOverrides({ base: semantics, overrides: firstPassSemantics }),
      exports: mergeWithOverrides({ base: exports, overrides: firstPassExports }),
      arena,
      effectInterner,
      diagnostics,
    });
    if (!result) {
      return;
    }
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
}): SemanticsPipelineResult | undefined => {
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
