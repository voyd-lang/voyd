import type {
  CallLoweringInfo,
  ModuleCodegenView,
  MonomorphizedInstanceInfo,
  ProgramCodegenView,
} from "../semantics/codegen-view/index.js";
import type {
  HirExpression,
  HirItem,
  HirStatement,
} from "../semantics/hir/index.js";
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
import type { ProgramOptimizationIndex } from "./program-index.js";

export type OptimizedCallInfo = CallLoweringInfo;

export type OptimizedModuleView = ModuleCodegenView & {
  semantics: SemanticsPipelineResult;
};

export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends ReadonlyMap<infer K, infer V>
    ? ReadonlyMap<DeepReadonly<K>, DeepReadonly<V>>
    : T extends ReadonlySet<infer V>
      ? ReadonlySet<DeepReadonly<V>>
      : T extends readonly (infer V)[]
        ? readonly DeepReadonly<V>[]
        : T extends object
          ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
          : T;

export type ReadonlyOptimizedModuleView = Omit<OptimizedModuleView, "hir"> & {
  readonly hir: Omit<
    OptimizedModuleView["hir"],
    "items" | "statements" | "expressions"
  > & {
    readonly items: ReadonlyMap<number, DeepReadonly<HirItem>>;
    readonly statements: ReadonlyMap<number, DeepReadonly<HirStatement>>;
    readonly expressions: ReadonlyMap<number, DeepReadonly<HirExpression>>;
  };
};

export type EscapeAnalysisOriginKind =
  | "aggregate"
  | "trait-object"
  | "closure-environment"
  | "effect-environment";

export type EscapeAnalysisEscapeReason =
  | "public-boundary"
  | "return"
  | "module-let"
  | "stored-in-aggregate"
  | "call-boundary"
  | "dynamic-dispatch"
  | "effectful-call"
  | "mutable-call-argument"
  | "closure-capture"
  | "effect-handler-capture"
  | "handler-resumption-escape"
  | "assignment"
  | "unknown";

export type EscapeAnalysisOriginFact = {
  originKind: EscapeAnalysisOriginKind;
  typeId?: TypeId;
  escapes: boolean;
  escapeReasons: readonly EscapeAnalysisEscapeReason[];
  directLocalSymbols: readonly SymbolId[];
  useExprIds: readonly HirExprId[];
};

export type EscapeAnalysisParameterFact = {
  escapes: boolean;
  escapeReasons: readonly EscapeAnalysisEscapeReason[];
  useExprIds: readonly HirExprId[];
};

export type ProgramEscapeAnalysisFacts = {
  origins: ReadonlyMap<
    string,
    ReadonlyMap<HirExprId, EscapeAnalysisOriginFact>
  >;
  parameters: ReadonlyMap<
    ProgramFunctionInstanceId,
    ReadonlyMap<SymbolId, EscapeAnalysisParameterFact>
  >;
};

export type CallShapeParameterState =
  | "provided"
  | "omitted"
  | "stable-callsite-id";

export type CallShapeSpecializationRequest = Readonly<{
  stage: "planned";
  identity: string;
  calleeInstanceId: ProgramFunctionInstanceId;
  keyTokens: readonly string[];
}>;

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
  callShapeSpecializationRequests: ReadonlyMap<
    string,
    ReadonlyMap<ProgramFunctionInstanceId, CallShapeSpecializationRequest>
  >;
  exactParameterTypes: ReadonlyMap<
    ProgramFunctionInstanceId,
    ReadonlyMap<SymbolId, TypeId>
  >;
  knownParameterTypes: ReadonlyMap<
    ProgramFunctionInstanceId,
    ReadonlyMap<SymbolId, ReadonlySet<TypeId>>
  >;
  escapeAnalysis: ProgramEscapeAnalysisFacts;
  runtimeTypeCheckElisionFieldAccesses: ReadonlyMap<
    string,
    ReadonlySet<HirExprId>
  >;
  semanticCopyForwardingFieldAccesses: ReadonlyMap<
    string,
    ReadonlySet<HirExprId>
  >;
  codegenPlan: ProgramCodegenOptimizationPlan;
};

export type ProgramOptimizationIR = {
  baseProgram: ProgramCodegenView;
  entryModuleId: string;
  options: {
    testMode: boolean;
    testScope: "all" | "entry";
    boundaryExports?: CodegenOptions["boundaryExports"];
    effectsHostBoundary?: CodegenOptions["effectsHostBoundary"];
  };
  modules: ReadonlyMap<string, ReadonlyOptimizedModuleView>;
  calls: ReadonlyMap<string, ReadonlyMap<HirExprId, OptimizedCallInfo>>;
  functionInstantiations: ReadonlyMap<
    string,
    ReadonlyMap<
      SymbolId,
      ReadonlyMap<ProgramFunctionInstanceId, readonly number[]>
    >
  >;
  survivingInstances: readonly MonomorphizedInstanceInfo[];
  /** Read-only index access; its structure invariant is checked after every pass. */
  index: ProgramOptimizationIndex;
  facts: ProgramOptimizationFacts;
};

export type ProgramOptimizationResult = {
  program: ProgramCodegenView;
  facts: ProgramOptimizationFacts;
};
