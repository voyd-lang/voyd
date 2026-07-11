import type {
  CallLoweringInfo,
  MonomorphizedInstanceInfo,
  ProgramCodegenView,
} from "../semantics/codegen-view/index.js";
import { buildEffectsIr } from "../semantics/effects/ir/build.js";
import type {
  HirExprId,
  ProgramFunctionInstanceId,
  ProgramSymbolId,
  SymbolId,
  TypeId,
} from "../semantics/ids.js";
import type { SemanticsPipelineResult } from "../semantics/pipeline.js";
import type { CodegenOptions } from "../codegen/context.js";
import type { HirGraph } from "../semantics/hir/index.js";
import type {
  EscapeAnalysisOriginFact,
  EscapeAnalysisParameterFact,
  CallShapeSpecializationRequest,
  OptimizedCallInfo,
  OptimizedModuleView,
} from "./ir.js";
import {
  createSpecializationReservations,
  type ProgramCodegenOptimizationPlan,
} from "./codegen-plan.js";
import { ProgramOptimizationIndex } from "./program-index.js";
import {
  resolveOptimizationPolicy,
  specializationPolicyForOptimizationLevel,
} from "../optimization-policy.js";

export type MutableOptimizationIr = {
  baseProgram: ProgramCodegenView;
  entryModuleId: string;
  options: {
    testMode: boolean;
    testScope: "all" | "entry";
    boundaryExports?: CodegenOptions["boundaryExports"];
    effectsHostBoundary?: CodegenOptions["effectsHostBoundary"];
  };
  modules: Map<string, OptimizedModuleView>;
  calls: Map<string, Map<HirExprId, OptimizedCallInfo>>;
  functionInstantiations: Map<
    string,
    Map<SymbolId, Map<ProgramFunctionInstanceId, readonly TypeId[]>>
  >;
  survivingInstances: MonomorphizedInstanceInfo[];
  index: ProgramOptimizationIndex;
  facts: {
    handlerClauseCaptures: Map<
      string,
      Map<HirExprId, Map<number, readonly SymbolId[]>>
    >;
    reachableFunctionInstances: Set<ProgramFunctionInstanceId>;
    reachableFunctionSymbols: Set<ProgramSymbolId>;
    reachableModuleLets: Map<string, Set<SymbolId>>;
    usedTraitDispatchSignatures: Set<string>;
    receiverSpecializationRequests: Map<
      string,
      Map<string, Map<SymbolId, TypeId>>
    >;
    callShapeSpecializationRequests: Map<
      string,
      Map<ProgramFunctionInstanceId, CallShapeSpecializationRequest>
    >;
    exactParameterTypes: Map<ProgramFunctionInstanceId, Map<SymbolId, TypeId>>;
    knownParameterTypes: Map<
      ProgramFunctionInstanceId,
      Map<SymbolId, Set<TypeId>>
    >;
    escapeAnalysis: {
      origins: Map<string, Map<HirExprId, EscapeAnalysisOriginFact>>;
      parameters: Map<
        ProgramFunctionInstanceId,
        Map<SymbolId, EscapeAnalysisParameterFact>
      >;
    };
    runtimeTypeCheckElisionFieldAccesses: Map<string, Set<HirExprId>>;
    semanticCopyForwardingFieldAccesses: Map<string, Set<HirExprId>>;
    codegenPlan: ProgramCodegenOptimizationPlan;
  };
};

export const normalizeFunctionInstantiations = ({
  program,
}: {
  program: ProgramCodegenView;
}): Map<
  string,
  Map<SymbolId, Map<ProgramFunctionInstanceId, readonly TypeId[]>>
> => {
  const byModule = new Map<
    string,
    Map<SymbolId, Map<ProgramFunctionInstanceId, readonly TypeId[]>>
  >();

  program.modules.forEach((moduleView, moduleId) => {
    const bySymbol = new Map<
      SymbolId,
      Map<ProgramFunctionInstanceId, readonly TypeId[]>
    >();
    moduleView.hir.items.forEach((item) => {
      if (item.kind !== "function") {
        return;
      }
      const instantiationInfo = program.functions.getInstantiationInfo(
        moduleId,
        item.symbol,
      );
      if (!instantiationInfo) {
        return;
      }
      bySymbol.set(item.symbol, new Map(instantiationInfo));
    });
    byModule.set(moduleId, bySymbol);
  });

  return byModule;
};

export const buildOptimizationIr = ({
  program,
  modules,
  entryModuleId,
  options,
}: {
  program: ProgramCodegenView;
  modules: readonly SemanticsPipelineResult[];
  entryModuleId: string;
  options?: CodegenOptions;
}): MutableOptimizationIr => {
  const specializationPolicy = specializationPolicyForOptimizationLevel(
    resolveOptimizationPolicy(options).level,
  );
  const semanticsByModuleId = new Map(
    modules.map((module) => [module.moduleId, module] as const),
  );
  const optimizedModules = new Map<string, OptimizedModuleView>();

  program.modules.forEach((moduleView, moduleId) => {
    const semantics = semanticsByModuleId.get(moduleId);
    if (!semantics) {
      return;
    }
    optimizedModules.set(moduleId, {
      ...moduleView,
      meta: freezeOptimizationValue(structuredClone(moduleView.meta)),
      semantics,
      hir: cloneOptimizerHir(moduleView.hir),
      effectsInfo: cloneHir(moduleView.effectsInfo),
      effectsIr: buildEffectsIr({
        hir: moduleView.hir,
        info: moduleView.effectsInfo,
      }),
    });
  });

  optimizedModules.forEach((moduleView, moduleId) => {
    moduleView.hir.items.forEach((item) => {
      if (item.kind !== "function") {
        return;
      }
      const signature = program.functions.getSignature(moduleId, item.symbol);
      if (signature) {
        freezeOptimizationValue(signature);
      }
    });
  });

  return {
    baseProgram: program,
    entryModuleId,
    options: {
      testMode: options?.testMode ?? false,
      testScope: options?.testScope ?? "all",
      boundaryExports: options?.boundaryExports,
      effectsHostBoundary: options?.effectsHostBoundary,
    },
    modules: optimizedModules,
    calls: normalizeCalls({ program }),
    functionInstantiations: normalizeFunctionInstantiations({ program }),
    survivingInstances: [...program.instances.getAll()],
    index: new ProgramOptimizationIndex(program, optimizedModules),
    facts: {
      handlerClauseCaptures: new Map(),
      reachableFunctionInstances: new Set(),
      reachableFunctionSymbols: new Set(),
      reachableModuleLets: new Map(),
      usedTraitDispatchSignatures: new Set(),
      receiverSpecializationRequests: new Map(),
      callShapeSpecializationRequests: new Map(),
      exactParameterTypes: new Map(),
      knownParameterTypes: new Map(),
      escapeAnalysis: {
        origins: new Map(),
        parameters: new Map(),
      },
      runtimeTypeCheckElisionFieldAccesses: new Map(),
      semanticCopyForwardingFieldAccesses: new Map(),
      codegenPlan: {
        representations: {},
        specializationPolicy,
        specializationReservations:
          createSpecializationReservations(specializationPolicy),
      },
    },
  };
};

const cloneHir = <T>(value: T): T => structuredClone(value);

export const freezeOptimizationValue = <T>(value: T): T => {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  if (value instanceof Map) {
    value.forEach((entry) => freezeOptimizationValue(entry));
    return value;
  }
  if (value instanceof Set) {
    value.forEach((entry) => freezeOptimizationValue(entry));
    return value;
  }
  Object.values(value).forEach((entry) => freezeOptimizationValue(entry));
  return Object.freeze(value);
};

const cloneOptimizerHir = (hir: HirGraph): HirGraph => {
  const cloned = cloneHir(hir);
  cloned.items.forEach((item) => freezeOptimizationValue(item));
  cloned.statements.forEach((statement) => freezeOptimizationValue(statement));
  cloned.expressions.forEach((expression) =>
    freezeOptimizationValue(expression),
  );
  return cloned;
};

const cloneCallInfo = (callInfo: CallLoweringInfo): OptimizedCallInfo => ({
  targets: callInfo.targets ? new Map(callInfo.targets) : undefined,
  argPlans: callInfo.argPlans ? new Map(callInfo.argPlans) : undefined,
  typeArgs: callInfo.typeArgs ? new Map(callInfo.typeArgs) : undefined,
  traitDispatch: callInfo.traitDispatch,
});

const normalizeCalls = ({
  program,
}: {
  program: ProgramCodegenView;
}): Map<string, Map<HirExprId, OptimizedCallInfo>> => {
  const byModule = new Map<string, Map<HirExprId, OptimizedCallInfo>>();

  program.modules.forEach((moduleView, moduleId) => {
    const calls = new Map<HirExprId, OptimizedCallInfo>();
    moduleView.hir.expressions.forEach((expr, exprId) => {
      if (expr.exprKind !== "call" && expr.exprKind !== "method-call") {
        return;
      }
      calls.set(
        exprId,
        cloneCallInfo(program.calls.getCallInfo(moduleId, exprId)),
      );
    });
    byModule.set(moduleId, calls);
  });

  return byModule;
};
