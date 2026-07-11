import type {
  CallResolutionMutation,
  CaptureMutation,
  HirTopologyMutation,
  OptimizationAnalysisKey,
  OptimizationAnalysisResultMap,
  ProducedFactsMutation,
  ProgramOptimizationContext,
  ReachabilityMutation,
} from "./pass.js";
import {
  freezeOptimizationValue,
  type MutableOptimizationIr,
} from "./state.js";
import { analyzeLambdaCaptures } from "../semantics/lowering/captures.js";
import { getSymbolTable } from "../semantics/_internal/symbol-table.js";
import type { HirExpression, HirStatement } from "../semantics/hir/index.js";
import type { HirGraph } from "../semantics/hir/index.js";

/** Optimizer-private mutable context and revision invalidation boundary. */
export class MutableOptimizationContext implements ProgramOptimizationContext {
  readonly analyses = new Map<
    OptimizationAnalysisKey,
    OptimizationAnalysisResultMap[OptimizationAnalysisKey]
  >();

  constructor(readonly ir: MutableOptimizationIr) {}

  getAnalysis<K extends OptimizationAnalysisKey>(
    key: K,
    build: () => OptimizationAnalysisResultMap[K],
  ): OptimizationAnalysisResultMap[K] {
    if (this.analyses.has(key)) {
      return this.analyses.get(key) as OptimizationAnalysisResultMap[K];
    }
    const analysis = build();
    this.analyses.set(key, analysis);
    return analysis;
  }

  mutateHirTopology<T>(
    moduleIds: readonly string[],
    mutate: (mutation: HirTopologyMutation) => T,
  ): T {
    if (moduleIds.length === 0) {
      throw new Error("HIR topology mutations must name affected modules");
    }
    const allowedModules = new Set(moduleIds);
    const moduleFor = (moduleId: string) => {
      if (!allowedModules.has(moduleId)) {
        throw new Error(`HIR mutation did not declare module ${moduleId}`);
      }
      const moduleView = this.ir.modules.get(moduleId);
      if (!moduleView) {
        throw new Error(`HIR mutation references unknown module ${moduleId}`);
      }
      return moduleView;
    };
    const result = mutate({
      setExpression: (moduleId, exprId, value) =>
        (moduleFor(moduleId).hir.expressions as Map<number, HirExpression>).set(
          exprId,
          freezeOptimizationValue(value),
        ),
      setStatement: (moduleId, statementId, value) =>
        (moduleFor(moduleId).hir.statements as Map<number, HirStatement>).set(
          statementId,
          freezeOptimizationValue(value),
        ),
    });
    this.invalidateHirBodyTopologies(moduleIds);
    this.invalidateAnalyses([
      "hir-body-topology",
      "reachable-function-instances",
      "handler-captures",
      "trait-dispatch-signatures",
    ]);
    return result;
  }

  mutateCallResolution<T>(mutate: (mutation: CallResolutionMutation) => T): T {
    const result = mutate({
      setCallInfo: (moduleId, exprId, value) => {
        const calls = this.ir.calls.get(moduleId);
        if (!calls) {
          throw new Error(
            `call mutation references unknown module ${moduleId}`,
          );
        }
        calls.set(exprId, value);
      },
    });
    this.invalidateAnalyses([
      "reachable-function-instances",
      "trait-dispatch-signatures",
    ]);
    return result;
  }

  mutateReachability<T>(mutate: (mutation: ReachabilityMutation) => T): T {
    const result = mutate({
      replaceProgramReachability: (value) => {
        this.ir.survivingInstances = [...value.survivingInstances];
        this.ir.functionInstantiations =
          value.functionInstantiations as MutableOptimizationIr["functionInstantiations"];
        this.ir.facts.reachableFunctionInstances = new Set(
          value.reachableFunctionInstances,
        );
        this.ir.facts.reachableFunctionSymbols = new Set(
          value.reachableFunctionSymbols,
        );
        this.ir.facts.reachableModuleLets =
          value.reachableModuleLets as MutableOptimizationIr["facts"]["reachableModuleLets"];
        this.ir.facts.usedTraitDispatchSignatures = new Set(
          value.usedTraitDispatchSignatures,
        );
      },
    });
    this.invalidateAnalyses(["reachable-function-instances"]);
    return result;
  }

  mutateCaptures<T>(mutate: (mutation: CaptureMutation) => T): T {
    const result = mutate({
      recomputeLambdaCaptures: (moduleId) => {
        const moduleView = this.ir.modules.get(moduleId);
        if (!moduleView) {
          throw new Error(
            `capture mutation references unknown module ${moduleId}`,
          );
        }
        const expressions = new Map(moduleView.hir.expressions);
        expressions.forEach((expression, exprId) => {
          if (expression.exprKind === "lambda") {
            expressions.set(exprId, structuredClone(expression));
          }
        });
        const hir = {
          ...moduleView.hir,
          expressions,
        } as HirGraph;
        analyzeLambdaCaptures({
          hir,
          symbolTable: getSymbolTable(moduleView.semantics),
          scopeByNode: moduleView.semantics.binding.scopeByNode,
        });
        const publishedExpressions = moduleView.hir.expressions as Map<
          number,
          HirExpression
        >;
        hir.expressions.forEach((expression, exprId) =>
          expression.exprKind === "lambda"
            ? publishedExpressions.set(
                exprId,
                freezeOptimizationValue(expression),
              )
            : undefined,
        );
      },
      setHandlerClauseCaptures: (moduleId, value) =>
        this.ir.facts.handlerClauseCaptures.set(
          moduleId,
          value as MutableOptimizationIr["facts"]["handlerClauseCaptures"] extends Map<
            string,
            infer T
          >
            ? T
            : never,
        ),
    });
    this.invalidateAnalyses(["handler-captures"]);
    return result;
  }

  mutateProducedFacts<T>(mutate: (mutation: ProducedFactsMutation) => T): T {
    const result = mutate({
      setFact: (key, value) => {
        (this.ir.facts as unknown as Record<string, unknown>)[key] = value;
      },
    });
    return result;
  }

  invalidateAnalyses(keys: readonly OptimizationAnalysisKey[]): void {
    keys.forEach((key) => this.analyses.delete(key));
  }

  invalidateHirBodyTopologies(moduleIds: readonly string[]): void {
    new Set(moduleIds).forEach((moduleId) =>
      this.ir.index.invalidateModuleTopology(moduleId),
    );
  }
}
