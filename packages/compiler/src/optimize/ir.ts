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
  TypeId,
} from "../semantics/ids.js";
import type { SemanticsPipelineResult } from "../semantics/pipeline.js";
import type { ProgramCodegenOptimizationPlan } from "./codegen-plan.js";
import type { CodegenOptions } from "../codegen/context.js";

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
  receiverSpecializationRequests: ReadonlyMap<
    string,
    ReadonlyMap<string, ReadonlyMap<SymbolId, TypeId>>
  >;
  exactParameterTypes: ReadonlyMap<
    ProgramFunctionInstanceId,
    ReadonlyMap<SymbolId, TypeId>
  >;
  knownParameterTypes: ReadonlyMap<
    ProgramFunctionInstanceId,
    ReadonlyMap<SymbolId, ReadonlySet<TypeId>>
  >;
  runtimeTypeCheckElisionFieldAccesses: ReadonlyMap<string, ReadonlySet<HirExprId>>;
  semanticCopyForwardingFieldAccesses: ReadonlyMap<string, ReadonlySet<HirExprId>>;
  codegenPlan: ProgramCodegenOptimizationPlan;
};

export type ProgramOptimizationIR = {
  baseProgram: ProgramCodegenView;
  entryModuleId: string;
  options: {
    testMode: boolean;
    testScope: "all" | "entry";
    boundaryExports?: CodegenOptions["boundaryExports"];
  };
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
