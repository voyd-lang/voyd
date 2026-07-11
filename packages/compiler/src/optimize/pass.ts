import type { ProgramOptimizationIR } from "./ir.js";
import type { OptimizedCallInfo, ProgramOptimizationFacts } from "./ir.js";
import type { ProgramFunctionInstanceId, SymbolId } from "../semantics/ids.js";
import type { HirExprId } from "../semantics/ids.js";
import type { HirExpression, HirStatement } from "../semantics/hir/index.js";
import type { OptimizationBodyTopology } from "./program-index.js";

export type OptimizationAnalysisResultMap = {
  "reachable-function-instances": ReadonlySet<ProgramFunctionInstanceId>;
  "handler-captures": ReadonlyMap<
    string,
    ReadonlyMap<number, readonly SymbolId[]>
  >;
  "trait-dispatch-signatures": ReadonlySet<string>;
  "hir-body-topology": OptimizationBodyTopology;
};

export type OptimizationAnalysisKey = keyof OptimizationAnalysisResultMap;

export type HirTopologyMutation = {
  setExpression(
    moduleId: string,
    exprId: HirExprId,
    value: HirExpression,
  ): void;
  setStatement(
    moduleId: string,
    statementId: number,
    value: HirStatement,
  ): void;
};

export type CallResolutionMutation = {
  setCallInfo(
    moduleId: string,
    exprId: HirExprId,
    value: OptimizedCallInfo,
  ): void;
};

export type ReachabilityMutation = {
  replaceProgramReachability(value: {
    survivingInstances: ProgramOptimizationIR["survivingInstances"];
    functionInstantiations: ProgramOptimizationIR["functionInstantiations"];
    reachableFunctionInstances: ProgramOptimizationFacts["reachableFunctionInstances"];
    reachableFunctionSymbols: ProgramOptimizationFacts["reachableFunctionSymbols"];
    reachableModuleLets: ProgramOptimizationFacts["reachableModuleLets"];
    usedTraitDispatchSignatures: ProgramOptimizationFacts["usedTraitDispatchSignatures"];
  }): void;
};

export type CaptureMutation = {
  recomputeLambdaCaptures(moduleId: string): void;
  setHandlerClauseCaptures(
    moduleId: string,
    value: ProgramOptimizationFacts["handlerClauseCaptures"] extends ReadonlyMap<
      string,
      infer T
    >
      ? T
      : never,
  ): void;
};

type ProducedFactKey = Exclude<
  keyof ProgramOptimizationFacts,
  | "handlerClauseCaptures"
  | "reachableFunctionInstances"
  | "reachableFunctionSymbols"
  | "reachableModuleLets"
  | "usedTraitDispatchSignatures"
  | "codegenPlan"
>;

export type ProducedFactsMutation = {
  setFact<K extends ProducedFactKey>(
    key: K,
    value: ProgramOptimizationFacts[K],
  ): void;
};

export type ProgramOptimizationPassResult = {
  changed: boolean;
  invalidates?: readonly OptimizationAnalysisKey[];
  /** Modules whose expression topology changed during this pass. */
  invalidatedHirModuleIds?: readonly string[];
  /**
   * Stable, additive counters describing useful work performed by the pass.
   * These are emitted only when compiler perf instrumentation is enabled.
   */
  metrics?: Readonly<Record<string, number>>;
};

export interface ProgramOptimizationContext {
  readonly ir: ProgramOptimizationIR;
  getAnalysis<K extends OptimizationAnalysisKey>(
    key: K,
    build: () => OptimizationAnalysisResultMap[K],
  ): OptimizationAnalysisResultMap[K];
  mutateHirTopology<T>(
    moduleIds: readonly string[],
    mutate: (mutation: HirTopologyMutation) => T,
  ): T;
  mutateCallResolution<T>(mutate: (mutation: CallResolutionMutation) => T): T;
  mutateReachability<T>(mutate: (mutation: ReachabilityMutation) => T): T;
  mutateCaptures<T>(mutate: (mutation: CaptureMutation) => T): T;
  mutateProducedFacts<T>(mutate: (mutation: ProducedFactsMutation) => T): T;
  invalidateAnalyses(keys: readonly OptimizationAnalysisKey[]): void;
  invalidateHirBodyTopologies(moduleIds: readonly string[]): void;
}

export type ProgramOptimizationPass = {
  name: string;
  run(ctx: ProgramOptimizationContext): ProgramOptimizationPassResult;
};
