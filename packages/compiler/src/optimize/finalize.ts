import type { ProgramCodegenView } from "../semantics/codegen-view/index.js";
import { buildEffectsLoweringInfo } from "../semantics/effects/analysis.js";
import { buildEffectsIr } from "../semantics/effects/ir/build.js";
import { getSymbolTable } from "../semantics/_internal/symbol-table.js";
import type { OptimizedModuleView, ProgramOptimizationResult } from "./ir.js";
import type { MutableOptimizationIr } from "./state.js";
import { publishOptimizationFacts } from "./publish-facts.js";

export const finalizeOptimization = ({
  ir,
}: {
  ir: MutableOptimizationIr;
}): ProgramOptimizationResult => {
  ir.modules.forEach((moduleView) => rebuildEffectsInfo({ moduleView }));
  const survivingInstancesById = new Map(
    ir.survivingInstances.map((instance) => [instance.instanceId, instance]),
  );

  const optimizedProgram: ProgramCodegenView = {
    ...ir.baseProgram,
    calls: {
      getCallInfo: (moduleId, exprId) =>
        ir.calls.get(moduleId)?.get(exprId) ??
        ir.baseProgram.calls.getCallInfo(moduleId, exprId),
    },
    functions: {
      ...ir.baseProgram.functions,
      getInstantiationInfo: (moduleId, symbol) =>
        ir.functionInstantiations.get(moduleId)?.get(symbol) ??
        ir.baseProgram.functions.getInstantiationInfo(moduleId, symbol),
    },
    instances: {
      getAll: () => ir.survivingInstances,
      getById: (instanceId) => survivingInstancesById.get(instanceId),
    },
    modules: new Map(
      Array.from(ir.modules.entries()).map(([moduleId, moduleView]) => {
        const { semantics, ...rest } = moduleView;
        void semantics;
        return [moduleId, rest];
      }),
    ),
  };

  return {
    program: optimizedProgram,
    facts: publishOptimizationFacts(ir.facts),
  };
};

const rebuildEffectsInfo = ({
  moduleView,
}: {
  moduleView: OptimizedModuleView;
}): void => {
  const effectsInfo = buildEffectsLoweringInfo({
    binding: moduleView.semantics.binding,
    symbolTable: getSymbolTable(moduleView.semantics),
    hir: moduleView.hir,
    typing: moduleView.semantics.typing,
  });
  moduleView.effectsInfo = effectsInfo;
  moduleView.effectsIr = buildEffectsIr({
    hir: moduleView.hir,
    info: effectsInfo,
  });
};
