import type {
  CallLoweringInfo,
  ModuleCodegenView,
  MonomorphizedInstanceInfo,
  ProgramCodegenView,
} from "../semantics/codegen-view/index.js";
import type {
  HirExprId,
  ProgramFunctionInstanceId,
  ProgramSymbolId,
  SymbolId,
} from "../semantics/ids.js";
import type { SemanticsPipelineResult } from "../semantics/pipeline.js";

export type OptimizedCallInfo = CallLoweringInfo;

export type OptimizedModuleView = ModuleCodegenView & {
  semantics: SemanticsPipelineResult;
};

export type ProgramOptimizationFacts = {
  handlerClauseCaptures: ReadonlyMap<
    string,
    ReadonlyMap<HirExprId, ReadonlyMap<number, readonly SymbolId[]>>
  >;
  reachableFunctionInstances: ReadonlySet<ProgramFunctionInstanceId>;
  reachableFunctionSymbols: ReadonlySet<ProgramSymbolId>;
  reachableModuleLets: ReadonlyMap<string, ReadonlySet<SymbolId>>;
  usedTraitDispatchSignatures: ReadonlySet<string>;
};

export type ProgramOptimizationIR = {
  baseProgram: ProgramCodegenView;
  entryModuleId: string;
  modules: ReadonlyMap<string, OptimizedModuleView>;
  calls: ReadonlyMap<string, ReadonlyMap<HirExprId, OptimizedCallInfo>>;
  functionInstantiations: ReadonlyMap<
    string,
    ReadonlyMap<SymbolId, ReadonlyMap<ProgramFunctionInstanceId, readonly number[]>>
  >;
  survivingInstances: readonly MonomorphizedInstanceInfo[];
  facts: ProgramOptimizationFacts;
};

export type ProgramOptimizationResult = {
  program: ProgramCodegenView;
  facts: ProgramOptimizationFacts;
};
