import type { ProgramCodegenView } from "../semantics/codegen-view/index.js";
import { buildEffectsLoweringInfo } from "../semantics/effects/analysis.js";
import { buildEffectsIr } from "../semantics/effects/ir/build.js";
import { getSymbolTable } from "../semantics/_internal/symbol-table.js";
import type { SymbolId, TypeId } from "../semantics/ids.js";
import type { ProgramCodegenOptimizationPlan } from "./codegen-plan.js";
import type { OptimizedModuleView, ProgramOptimizationResult } from "./ir.js";
import type { MutableOptimizationIr } from "./state.js";

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

  const codegenPlan: ProgramCodegenOptimizationPlan = {
    representations: { ...ir.facts.codegenPlan.representations },
    specializationPolicy: ir.facts.codegenPlan.specializationPolicy,
  };

  return {
    program: optimizedProgram,
    facts: {
      handlerClauseCaptures: new Map(
        Array.from(ir.facts.handlerClauseCaptures.entries()).map(
          ([moduleId, byHandler]) => [
            moduleId,
            new Map(
              Array.from(byHandler.entries()).map(
                ([handlerExprId, byClause]) => [
                  handlerExprId,
                  new Map(byClause),
                ],
              ),
            ),
          ],
        ),
      ),
      reachableFunctionInstances: new Set(ir.facts.reachableFunctionInstances),
      reachableFunctionSymbols: new Set(ir.facts.reachableFunctionSymbols),
      reachableModuleLets: new Map(
        Array.from(ir.facts.reachableModuleLets.entries()).map(
          ([moduleId, symbols]) => [moduleId, new Set(symbols)],
        ),
      ),
      usedTraitDispatchSignatures: new Set(
        ir.facts.usedTraitDispatchSignatures,
      ),
      receiverSpecializationRequests: cloneReceiverSpecializationRequests(
        ir.facts.receiverSpecializationRequests,
      ),
      callShapeSpecializationRequests: new Map(
        Array.from(ir.facts.callShapeSpecializationRequests.entries()).map(
          ([callSiteKey, byCaller]) => [
            callSiteKey,
            new Map(
              Array.from(byCaller.entries()).map(
                ([callerInstanceId, request]) => [
                  callerInstanceId,
                  {
                    ...request,
                    keyTokens: [...request.keyTokens],
                  },
                ],
              ),
            ),
          ],
        ),
      ),
      exactParameterTypes: new Map(
        Array.from(ir.facts.exactParameterTypes.entries()).map(
          ([instanceId, bySymbol]) => [instanceId, new Map(bySymbol)],
        ),
      ),
      knownParameterTypes: new Map(
        Array.from(ir.facts.knownParameterTypes.entries()).map(
          ([instanceId, bySymbol]) => [
            instanceId,
            new Map(
              Array.from(bySymbol.entries()).map(([symbol, types]) => [
                symbol,
                new Set(types),
              ]),
            ),
          ],
        ),
      ),
      escapeAnalysis: {
        origins: new Map(
          Array.from(ir.facts.escapeAnalysis.origins.entries()).map(
            ([moduleId, byExpr]) => [
              moduleId,
              new Map(
                Array.from(byExpr.entries()).map(([exprId, fact]) => [
                  exprId,
                  {
                    ...fact,
                    escapeReasons: [...fact.escapeReasons],
                    directLocalSymbols: [...fact.directLocalSymbols],
                    useExprIds: [...fact.useExprIds],
                  },
                ]),
              ),
            ],
          ),
        ),
        parameters: new Map(
          Array.from(ir.facts.escapeAnalysis.parameters.entries()).map(
            ([instanceId, bySymbol]) => [
              instanceId,
              new Map(
                Array.from(bySymbol.entries()).map(([symbol, fact]) => [
                  symbol,
                  {
                    ...fact,
                    escapeReasons: [...fact.escapeReasons],
                    useExprIds: [...fact.useExprIds],
                  },
                ]),
              ),
            ],
          ),
        ),
      },
      runtimeTypeCheckElisionFieldAccesses: new Map(
        Array.from(ir.facts.runtimeTypeCheckElisionFieldAccesses.entries()).map(
          ([moduleId, exprIds]) => [moduleId, new Set(exprIds)],
        ),
      ),
      semanticCopyForwardingFieldAccesses: new Map(
        Array.from(ir.facts.semanticCopyForwardingFieldAccesses.entries()).map(
          ([moduleId, exprIds]) => [moduleId, new Set(exprIds)],
        ),
      ),
      codegenPlan,
    },
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

const cloneReceiverSpecializationRequests = (
  requests: ReadonlyMap<
    string,
    ReadonlyMap<string, ReadonlyMap<SymbolId, TypeId>>
  >,
): Map<string, Map<string, Map<SymbolId, TypeId>>> =>
  new Map(
    Array.from(requests.entries()).map(([callSiteKey, byContext]) => [
      callSiteKey,
      new Map(
        Array.from(byContext.entries()).map(([contextKey, exactTypes]) => [
          contextKey,
          new Map(exactTypes),
        ]),
      ),
    ]),
  );
