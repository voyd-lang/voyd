import type {
  ProgramFunctionInstanceId,
  SymbolId,
  TypeId,
} from "../../semantics/ids.js";
import { type ProgramOptimizationPass } from "../pass.js";
import { type ProgramOptimizationIR } from "../ir.js";
import {
  callArgumentExprIdForParameter,
  exactNominalForExpr,
  InstanceCallSiteIndex,
  buildInstanceCallSiteIndex,
  callArgumentExprIds,
  resolveTargetsForExactPropagation,
  externallyCallableFunctionInstances,
  receiverSpecializationCallSiteKey,
  knownNominalsForExpr,
} from "./shared.js";

export type ExactParameterCandidate = TypeId | "conflict";

export const mergeExactParameterCandidate = ({
  candidates,
  instanceId,
  symbol,
  exactType,
}: {
  candidates: Map<
    ProgramFunctionInstanceId,
    Map<SymbolId, ExactParameterCandidate>
  >;
  instanceId: ProgramFunctionInstanceId;
  symbol: SymbolId;
  exactType: TypeId;
}): void => {
  const bySymbol =
    candidates.get(instanceId) ?? new Map<SymbolId, ExactParameterCandidate>();
  const existing = bySymbol.get(symbol);
  bySymbol.set(
    symbol,
    existing === undefined || existing === exactType ? exactType : "conflict",
  );
  candidates.set(instanceId, bySymbol);
};

export const collectExactParameterCandidates = ({
  ir,
  callSites,
  seedFacts,
  externallyCallableInstances,
}: {
  ir: ProgramOptimizationIR;
  callSites: InstanceCallSiteIndex;
  seedFacts: ReadonlyMap<
    ProgramFunctionInstanceId,
    ReadonlyMap<SymbolId, TypeId>
  >;
  externallyCallableInstances: ReadonlySet<ProgramFunctionInstanceId>;
}): Map<ProgramFunctionInstanceId, Map<SymbolId, ExactParameterCandidate>> => {
  const candidates = new Map<
    ProgramFunctionInstanceId,
    Map<SymbolId, ExactParameterCandidate>
  >();

  callSites.forEach((sites, callerInstanceId) => {
    sites.forEach(({ moduleView, exprId, expr }) => {
      const argExprIds = callArgumentExprIds(expr);
      const callInfo = ir.calls.get(moduleView.moduleId)?.get(exprId);
      const targets = resolveTargetsForExactPropagation({
        moduleView,
        exprId,
        expr,
        callerInstanceId,
        ir,
      });
      targets.forEach(({ instanceId }) => {
        if (typeof instanceId !== "number") {
          return;
        }
        if (externallyCallableInstances.has(instanceId)) {
          return;
        }
        const target = ir.baseProgram.functions.getInstance(instanceId);
        const signature = ir.baseProgram.functions.getSignature(
          target.symbolRef.moduleId,
          target.symbolRef.symbol,
        );
        if (!signature) {
          return;
        }
        signature.parameters.forEach((parameter, index) => {
          if (typeof parameter.symbol !== "number") {
            return;
          }
          const argExprId = callArgumentExprIdForParameter({
            argExprIds,
            callInfo,
            callerInstanceId,
            parameterIndex: index,
          });
          if (typeof argExprId !== "number") {
            return;
          }
          const exactType = exactNominalForExpr({
            moduleView,
            exprId: argExprId,
            callerInstanceId,
            program: ir.baseProgram,
            exactParameterTypes: seedFacts,
          });
          if (typeof exactType !== "number") {
            return;
          }
          mergeExactParameterCandidate({
            candidates,
            instanceId,
            symbol: parameter.symbol,
            exactType,
          });
        });
      });
    });
  });

  return candidates;
};

export const materializeExactParameterFacts = (
  candidates: ReadonlyMap<
    ProgramFunctionInstanceId,
    ReadonlyMap<SymbolId, ExactParameterCandidate>
  >,
): Map<ProgramFunctionInstanceId, Map<SymbolId, TypeId>> => {
  const facts = new Map<ProgramFunctionInstanceId, Map<SymbolId, TypeId>>();
  candidates.forEach((bySymbol, instanceId) => {
    const exactBySymbol = new Map<SymbolId, TypeId>();
    bySymbol.forEach((candidate, symbol) => {
      if (candidate !== "conflict") {
        exactBySymbol.set(symbol, candidate);
      }
    });
    if (exactBySymbol.size > 0) {
      facts.set(instanceId, exactBySymbol);
    }
  });
  return facts;
};

export const cloneExactParameterFacts = (
  facts: ReadonlyMap<ProgramFunctionInstanceId, ReadonlyMap<SymbolId, TypeId>>,
): Map<ProgramFunctionInstanceId, Map<SymbolId, TypeId>> =>
  new Map(
    Array.from(facts.entries()).map(([instanceId, bySymbol]) => [
      instanceId,
      new Map(bySymbol),
    ]),
  );

export type KnownParameterCandidate = {
  types: Set<TypeId>;
  unknown: boolean;
};

export const cloneKnownParameterFacts = (
  facts: ReadonlyMap<
    ProgramFunctionInstanceId,
    ReadonlyMap<SymbolId, ReadonlySet<TypeId>>
  >,
): Map<ProgramFunctionInstanceId, Map<SymbolId, Set<TypeId>>> =>
  new Map(
    Array.from(facts.entries()).map(([instanceId, bySymbol]) => [
      instanceId,
      new Map(
        Array.from(bySymbol.entries()).map(([symbol, types]) => [
          symbol,
          new Set(types),
        ]),
      ),
    ]),
  );

export const receiverSpecializationContextKey = ({
  instanceId,
  exactParameterTypes,
}: {
  instanceId: ProgramFunctionInstanceId;
  exactParameterTypes: ReadonlyMap<SymbolId, TypeId> | undefined;
}): string => {
  const serializedFacts = Array.from(exactParameterTypes?.entries() ?? [])
    .sort(([left], [right]) => left - right)
    .map(([symbol, type]) => `${symbol}=${type}`)
    .join(",");
  return `${instanceId}:${serializedFacts}`;
};

export const serializeReceiverSpecializationRequests = (
  requests: ReadonlyMap<
    string,
    ReadonlyMap<string, ReadonlyMap<SymbolId, TypeId>>
  >,
): string =>
  JSON.stringify(
    Array.from(requests.entries())
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([callSiteKey, byContext]) => [
        callSiteKey,
        Array.from(byContext.entries())
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([contextKey, exactTypes]) => [
            contextKey,
            Array.from(exactTypes.entries()).sort(
              ([left], [right]) => left - right,
            ),
          ]),
      ]),
  );

export const mergeKnownParameterCandidate = ({
  candidates,
  instanceId,
  symbol,
  knownTypes,
}: {
  candidates: Map<
    ProgramFunctionInstanceId,
    Map<SymbolId, KnownParameterCandidate>
  >;
  instanceId: ProgramFunctionInstanceId;
  symbol: SymbolId;
  knownTypes?: ReadonlySet<TypeId>;
}): void => {
  const bySymbol =
    candidates.get(instanceId) ?? new Map<SymbolId, KnownParameterCandidate>();
  const existing = bySymbol.get(symbol) ?? {
    types: new Set<TypeId>(),
    unknown: false,
  };
  if (!knownTypes || knownTypes.size === 0) {
    existing.unknown = true;
  } else {
    knownTypes.forEach((type) => existing.types.add(type));
  }
  bySymbol.set(symbol, existing);
  candidates.set(instanceId, bySymbol);
};

export const collectKnownParameterCandidates = ({
  ir,
  callSites,
  exactParameterTypes,
  seedFacts,
  externallyCallableInstances,
}: {
  ir: ProgramOptimizationIR;
  callSites: InstanceCallSiteIndex;
  exactParameterTypes: ReadonlyMap<
    ProgramFunctionInstanceId,
    ReadonlyMap<SymbolId, TypeId>
  >;
  seedFacts: ReadonlyMap<
    ProgramFunctionInstanceId,
    ReadonlyMap<SymbolId, ReadonlySet<TypeId>>
  >;
  externallyCallableInstances: ReadonlySet<ProgramFunctionInstanceId>;
}): Map<ProgramFunctionInstanceId, Map<SymbolId, KnownParameterCandidate>> => {
  const candidates = new Map<
    ProgramFunctionInstanceId,
    Map<SymbolId, KnownParameterCandidate>
  >();

  callSites.forEach((sites, callerInstanceId) => {
    sites.forEach(({ moduleView, exprId, expr }) => {
      const argExprIds = callArgumentExprIds(expr);
      const callInfo = ir.calls.get(moduleView.moduleId)?.get(exprId);
      const targets = resolveTargetsForExactPropagation({
        moduleView,
        exprId,
        expr,
        callerInstanceId,
        ir,
      });
      targets.forEach(({ instanceId }) => {
        if (typeof instanceId !== "number") {
          return;
        }
        if (externallyCallableInstances.has(instanceId)) {
          return;
        }
        const target = ir.baseProgram.functions.getInstance(instanceId);
        const signature = ir.baseProgram.functions.getSignature(
          target.symbolRef.moduleId,
          target.symbolRef.symbol,
        );
        if (!signature) {
          return;
        }
        signature.parameters.forEach((parameter, index) => {
          if (typeof parameter.symbol !== "number") {
            return;
          }
          const argExprId = callArgumentExprIdForParameter({
            argExprIds,
            callInfo,
            callerInstanceId,
            parameterIndex: index,
          });
          const knownTypes =
            typeof argExprId === "number"
              ? knownNominalsForExpr({
                  moduleView,
                  exprId: argExprId,
                  callerInstanceId,
                  program: ir.baseProgram,
                  exactParameterTypes,
                  knownParameterTypes: seedFacts,
                })
              : undefined;
          mergeKnownParameterCandidate({
            candidates,
            instanceId,
            symbol: parameter.symbol,
            knownTypes,
          });
        });
      });
    });
  });

  return candidates;
};

export const materializeKnownParameterFacts = (
  candidates: ReadonlyMap<
    ProgramFunctionInstanceId,
    ReadonlyMap<SymbolId, KnownParameterCandidate>
  >,
): Map<ProgramFunctionInstanceId, Map<SymbolId, Set<TypeId>>> => {
  const facts = new Map<
    ProgramFunctionInstanceId,
    Map<SymbolId, Set<TypeId>>
  >();
  candidates.forEach((bySymbol, instanceId) => {
    const knownBySymbol = new Map<SymbolId, Set<TypeId>>();
    bySymbol.forEach((candidate, symbol) => {
      if (!candidate.unknown && candidate.types.size > 0) {
        knownBySymbol.set(symbol, new Set(candidate.types));
      }
    });
    if (knownBySymbol.size > 0) {
      facts.set(instanceId, knownBySymbol);
    }
  });
  return facts;
};

export const setContainsAll = (
  expected: ReadonlySet<TypeId>,
  actual: ReadonlySet<TypeId>,
): boolean => Array.from(actual).every((type) => expected.has(type));

export const validateKnownParameterFacts = ({
  ir,
  callSites,
  exactParameterTypes,
  facts,
}: {
  ir: ProgramOptimizationIR;
  callSites: InstanceCallSiteIndex;
  exactParameterTypes: ReadonlyMap<
    ProgramFunctionInstanceId,
    ReadonlyMap<SymbolId, TypeId>
  >;
  facts: Map<ProgramFunctionInstanceId, Map<SymbolId, Set<TypeId>>>;
}): Map<ProgramFunctionInstanceId, Map<SymbolId, Set<TypeId>>> => {
  const validated = cloneKnownParameterFacts(facts);
  let changed = true;

  while (changed) {
    changed = false;
    callSites.forEach((sites, callerInstanceId) => {
      sites.forEach(({ moduleView, exprId, expr }) => {
        const argExprIds = callArgumentExprIds(expr);
        const callInfo = ir.calls.get(moduleView.moduleId)?.get(exprId);
        resolveTargetsForExactPropagation({
          moduleView,
          exprId,
          expr,
          callerInstanceId,
          ir,
        }).forEach(({ instanceId }) => {
          if (typeof instanceId !== "number") {
            return;
          }
          const factsBySymbol = validated.get(instanceId);
          if (!factsBySymbol || factsBySymbol.size === 0) {
            return;
          }
          const target = ir.baseProgram.functions.getInstance(instanceId);
          const signature = ir.baseProgram.functions.getSignature(
            target.symbolRef.moduleId,
            target.symbolRef.symbol,
          );
          signature?.parameters.forEach((parameter, index) => {
            if (typeof parameter.symbol !== "number") {
              return;
            }
            const expected = factsBySymbol.get(parameter.symbol);
            if (!expected) {
              return;
            }
            const argExprId = callArgumentExprIdForParameter({
              argExprIds,
              callInfo,
              callerInstanceId,
              parameterIndex: index,
            });
            const actual =
              typeof argExprId === "number"
                ? knownNominalsForExpr({
                    moduleView,
                    exprId: argExprId,
                    callerInstanceId,
                    program: ir.baseProgram,
                    exactParameterTypes,
                    knownParameterTypes: validated,
                  })
                : undefined;
            if (actual && setContainsAll(expected, actual)) {
              return;
            }
            factsBySymbol.delete(parameter.symbol);
            changed = true;
          });
          if (factsBySymbol.size === 0) {
            validated.delete(instanceId);
          }
        });
      });
    });
  }

  return validated;
};

export const serializeKnownParameterFacts = (
  facts: ReadonlyMap<
    ProgramFunctionInstanceId,
    ReadonlyMap<SymbolId, ReadonlySet<TypeId>>
  >,
): string =>
  JSON.stringify(
    Array.from(facts.entries())
      .sort(([left], [right]) => left - right)
      .map(([instanceId, bySymbol]) => [
        instanceId,
        Array.from(bySymbol.entries())
          .sort(([left], [right]) => left - right)
          .map(([symbol, types]) => [
            symbol,
            Array.from(types).sort((left, right) => left - right),
          ]),
      ]),
  );

export const validateExactParameterFacts = ({
  ir,
  callSites,
  facts,
}: {
  ir: ProgramOptimizationIR;
  callSites: InstanceCallSiteIndex;
  facts: Map<ProgramFunctionInstanceId, Map<SymbolId, TypeId>>;
}): Map<ProgramFunctionInstanceId, Map<SymbolId, TypeId>> => {
  const validated = cloneExactParameterFacts(facts);
  let changed = true;

  while (changed) {
    changed = false;
    callSites.forEach((sites, callerInstanceId) => {
      sites.forEach(({ moduleView, exprId, expr }) => {
        const argExprIds = callArgumentExprIds(expr);
        const callInfo = ir.calls.get(moduleView.moduleId)?.get(exprId);
        resolveTargetsForExactPropagation({
          moduleView,
          exprId,
          expr,
          callerInstanceId,
          ir,
        }).forEach(({ instanceId }) => {
          if (typeof instanceId !== "number") {
            return;
          }
          const factsBySymbol = validated.get(instanceId);
          if (!factsBySymbol || factsBySymbol.size === 0) {
            return;
          }
          const target = ir.baseProgram.functions.getInstance(instanceId);
          const signature = ir.baseProgram.functions.getSignature(
            target.symbolRef.moduleId,
            target.symbolRef.symbol,
          );
          signature?.parameters.forEach((parameter, index) => {
            if (typeof parameter.symbol !== "number") {
              return;
            }
            const expected = factsBySymbol.get(parameter.symbol);
            if (typeof expected !== "number") {
              return;
            }
            const argExprId = callArgumentExprIdForParameter({
              argExprIds,
              callInfo,
              callerInstanceId,
              parameterIndex: index,
            });
            const actual =
              typeof argExprId === "number"
                ? exactNominalForExpr({
                    moduleView,
                    exprId: argExprId,
                    callerInstanceId,
                    program: ir.baseProgram,
                    exactParameterTypes: validated,
                  })
                : undefined;
            if (actual === expected) {
              return;
            }
            factsBySymbol.delete(parameter.symbol);
            changed = true;
          });
          if (factsBySymbol.size === 0) {
            validated.delete(instanceId);
          }
        });
      });
    });
  }

  return validated;
};

export const serializeExactParameterFacts = (
  facts: ReadonlyMap<ProgramFunctionInstanceId, ReadonlyMap<SymbolId, TypeId>>,
): string =>
  JSON.stringify(
    Array.from(facts.entries())
      .sort(([left], [right]) => left - right)
      .map(([instanceId, bySymbol]) => [
        instanceId,
        Array.from(bySymbol.entries()).sort(([left], [right]) => left - right),
      ]),
  );

export type ReceiverSpecializationContext = {
  instanceId: ProgramFunctionInstanceId;
  exactParameterTypes: Map<SymbolId, TypeId>;
};

export const exactParameterFactsForContext = ({
  facts,
  context,
}: {
  facts: ReadonlyMap<ProgramFunctionInstanceId, ReadonlyMap<SymbolId, TypeId>>;
  context: ReceiverSpecializationContext;
}): Map<ProgramFunctionInstanceId, Map<SymbolId, TypeId>> => {
  const merged = cloneExactParameterFacts(facts);
  if (context.exactParameterTypes.size === 0) {
    return merged;
  }
  const existing = new Map(merged.get(context.instanceId) ?? []);
  context.exactParameterTypes.forEach((type, symbol) => {
    existing.set(symbol, type);
  });
  merged.set(context.instanceId, existing);
  return merged;
};

export const functionParameterNodeKey = ({
  functionInstanceId,
  parameterSymbol,
}: {
  functionInstanceId: ProgramFunctionInstanceId;
  parameterSymbol: SymbolId;
}): string => `${functionInstanceId}:${parameterSymbol}`;

export const computeTraitDispatchReachableParameters = ({
  ir,
  callSites,
}: {
  ir: ProgramOptimizationIR;
  callSites: InstanceCallSiteIndex;
}): Set<string> => {
  const reachable = new Set<string>();
  const predecessors = new Map<string, Set<string>>();

  callSites.forEach((sites, functionInstanceId) => {
    sites.forEach(({ moduleView, exprId, expr }) => {
      const callInfo = ir.calls.get(moduleView.moduleId)?.get(exprId);
      if (callInfo?.traitDispatch) {
        const receiverExprId =
          expr.exprKind === "method-call" ? expr.target : expr.args[0]?.expr;
        const receiverExpr =
          typeof receiverExprId === "number"
            ? moduleView.hir.expressions.get(receiverExprId)
            : undefined;
        if (
          receiverExpr?.exprKind === "identifier" &&
          typeof receiverExpr.symbol === "number"
        ) {
          reachable.add(
            functionParameterNodeKey({
              functionInstanceId,
              parameterSymbol: receiverExpr.symbol,
            }),
          );
        }
      }

      const argExprIds = callArgumentExprIds(expr);
      resolveTargetsForExactPropagation({
        moduleView,
        exprId,
        expr,
        callerInstanceId: functionInstanceId,
        ir,
      }).forEach(({ instanceId }) => {
        if (typeof instanceId !== "number") {
          return;
        }
        const target = ir.baseProgram.functions.getInstance(instanceId);
        const signature = ir.baseProgram.functions.getSignature(
          target.symbolRef.moduleId,
          target.symbolRef.symbol,
        );
        signature?.parameters.forEach((targetParam, paramIndex) => {
          if (typeof targetParam.symbol !== "number") {
            return;
          }
          if (
            ir.baseProgram.types.getTypeDesc(targetParam.typeId).kind !==
            "trait"
          ) {
            return;
          }
          const argExprId = callArgumentExprIdForParameter({
            argExprIds,
            callInfo,
            callerInstanceId: functionInstanceId,
            parameterIndex: paramIndex,
          });
          const argExpr =
            typeof argExprId === "number"
              ? moduleView.hir.expressions.get(argExprId)
              : undefined;
          if (argExpr?.exprKind !== "identifier") {
            return;
          }
          const sourceKey = functionParameterNodeKey({
            functionInstanceId,
            parameterSymbol: argExpr.symbol,
          });
          const targetKey = functionParameterNodeKey({
            functionInstanceId: instanceId,
            parameterSymbol: targetParam.symbol,
          });
          const targetPredecessors = predecessors.get(targetKey) ?? new Set();
          targetPredecessors.add(sourceKey);
          predecessors.set(targetKey, targetPredecessors);
        });
      });
    });
  });

  const pending = [...reachable];
  while (pending.length > 0) {
    const targetKey = pending.pop()!;
    predecessors.get(targetKey)?.forEach((sourceKey) => {
      if (reachable.has(sourceKey)) {
        return;
      }
      reachable.add(sourceKey);
      pending.push(sourceKey);
    });
  }

  return reachable;
};

export const collectReceiverSpecializationRequests = ({
  ir,
  callSites,
  exactParameterTypes,
}: {
  ir: ProgramOptimizationIR;
  callSites: InstanceCallSiteIndex;
  exactParameterTypes: ReadonlyMap<
    ProgramFunctionInstanceId,
    ReadonlyMap<SymbolId, TypeId>
  >;
}): Map<string, Map<string, Map<SymbolId, TypeId>>> => {
  const requests = new Map<string, Map<string, Map<SymbolId, TypeId>>>();
  const queued: ReceiverSpecializationContext[] = [];
  const queuedKeys = new Set<string>();
  const seen = new Set<string>();
  const specializationKeysByFunction = new Map<
    ProgramFunctionInstanceId,
    Set<string>
  >();
  const traitDispatchReachableParameters =
    computeTraitDispatchReachableParameters({ ir, callSites });

  const enqueueContext = ({
    instanceId,
    exactTypes,
    countsAsSpecialization,
  }: {
    instanceId: ProgramFunctionInstanceId;
    exactTypes?: ReadonlyMap<SymbolId, TypeId>;
    countsAsSpecialization: boolean;
  }): void => {
    const exactParameterMap = new Map(exactTypes ?? []);
    const contextKey = receiverSpecializationContextKey({
      instanceId,
      exactParameterTypes: exactParameterMap,
    });
    if (seen.has(contextKey) || queuedKeys.has(contextKey)) {
      return;
    }
    if (countsAsSpecialization) {
      if (
        exactParameterMap.size === 0 ||
        exactParameterMap.size >
          ir.facts.codegenPlan.specializationPolicy
            .receiverExactParametersPerContext
      ) {
        return;
      }
      const knownKeys =
        specializationKeysByFunction.get(instanceId) ?? new Set<string>();
      if (
        !knownKeys.has(contextKey) &&
        knownKeys.size >=
          Math.min(
            ir.facts.codegenPlan.specializationPolicy
              .receiverContextsPerFunction,
            ir.facts.codegenPlan.specializationReservations.receiver
              .contextsPerFunction,
          )
      ) {
        return;
      }
      knownKeys.add(contextKey);
      specializationKeysByFunction.set(instanceId, knownKeys);
    }
    queuedKeys.add(contextKey);
    queued.push({
      instanceId,
      exactParameterTypes: exactParameterMap,
    });
  };

  ir.facts.reachableFunctionInstances.forEach((instanceId) => {
    enqueueContext({
      instanceId,
      exactTypes: exactParameterTypes.get(instanceId),
      countsAsSpecialization: false,
    });
  });

  while (queued.length > 0) {
    const context = queued.pop()!;
    const callerContextKey = receiverSpecializationContextKey({
      instanceId: context.instanceId,
      exactParameterTypes: context.exactParameterTypes,
    });
    queuedKeys.delete(callerContextKey);
    if (seen.has(callerContextKey)) {
      continue;
    }
    seen.add(callerContextKey);

    const contextExactFacts = exactParameterFactsForContext({
      facts: exactParameterTypes,
      context,
    });
    const sites = callSites.get(context.instanceId) ?? [];
    sites.forEach(({ moduleView, exprId, expr }) => {
      const targets = resolveTargetsForExactPropagation({
        moduleView,
        exprId,
        expr,
        callerInstanceId: context.instanceId,
        ir,
      });
      if (targets.length !== 1 || typeof targets[0]?.instanceId !== "number") {
        return;
      }

      const targetInstanceId = targets[0].instanceId;
      const target = ir.baseProgram.functions.getInstance(targetInstanceId);
      const signature = ir.baseProgram.functions.getSignature(
        target.symbolRef.moduleId,
        target.symbolRef.symbol,
      );
      if (!signature) {
        return;
      }
      const callInfo = ir.calls.get(moduleView.moduleId)?.get(exprId);
      const argExprIds = callArgumentExprIds(expr);
      const requestedExactTypes = new Map<SymbolId, TypeId>();
      signature.parameters.forEach((parameter, paramIndex) => {
        if (typeof parameter.symbol !== "number") {
          return;
        }
        if (
          ir.baseProgram.types.getTypeDesc(parameter.typeId).kind !== "trait"
        ) {
          return;
        }
        const argExprId = callArgumentExprIdForParameter({
          argExprIds,
          callInfo,
          callerInstanceId: context.instanceId,
          parameterIndex: paramIndex,
        });
        if (typeof argExprId !== "number") {
          return;
        }
        const exactType = exactNominalForExpr({
          moduleView,
          exprId: argExprId,
          callerInstanceId: context.instanceId,
          program: ir.baseProgram,
          exactParameterTypes: contextExactFacts,
        });
        if (typeof exactType !== "number") {
          return;
        }
        const existingExact = exactParameterTypes
          .get(targetInstanceId)
          ?.get(parameter.symbol);
        if (existingExact === exactType) {
          return;
        }
        if (
          !traitDispatchReachableParameters.has(
            functionParameterNodeKey({
              functionInstanceId: targetInstanceId,
              parameterSymbol: parameter.symbol,
            }),
          )
        ) {
          return;
        }
        requestedExactTypes.set(parameter.symbol, exactType);
      });

      if (
        requestedExactTypes.size === 0 ||
        requestedExactTypes.size >
          ir.facts.codegenPlan.specializationPolicy
            .receiverExactParametersPerContext
      ) {
        return;
      }

      const callSiteKey = receiverSpecializationCallSiteKey({
        moduleId: moduleView.moduleId,
        exprId,
      });
      const byContext =
        requests.get(callSiteKey) ?? new Map<string, Map<SymbolId, TypeId>>();
      byContext.set(callerContextKey, requestedExactTypes);
      requests.set(callSiteKey, byContext);

      const targetContextExactTypes = new Map(
        exactParameterTypes.get(targetInstanceId) ?? [],
      );
      requestedExactTypes.forEach((type, symbol) => {
        targetContextExactTypes.set(symbol, type);
      });
      enqueueContext({
        instanceId: targetInstanceId,
        exactTypes: targetContextExactTypes,
        countsAsSpecialization: true,
      });
    });
  }

  return requests;
};

export const exactReceiverPropagationPass: ProgramOptimizationPass = {
  name: "exact-receiver-propagation",
  run(ctx) {
    const callSites = buildInstanceCallSiteIndex({
      ir: ctx.ir,
    });
    const externallyCallableInstances = externallyCallableFunctionInstances(
      ctx.ir,
    );
    let exactFacts = new Map<
      ProgramFunctionInstanceId,
      Map<SymbolId, TypeId>
    >();
    let changed = true;

    while (changed) {
      const candidates = collectExactParameterCandidates({
        ir: ctx.ir,
        callSites,
        seedFacts: exactFacts,
        externallyCallableInstances,
      });
      const nextFacts = materializeExactParameterFacts(candidates);
      changed =
        serializeExactParameterFacts(nextFacts) !==
        serializeExactParameterFacts(exactFacts);
      exactFacts = nextFacts;
    }

    const validatedExact = validateExactParameterFacts({
      ir: ctx.ir,
      callSites,
      facts: exactFacts,
    });

    let knownFacts = new Map<
      ProgramFunctionInstanceId,
      Map<SymbolId, Set<TypeId>>
    >();
    changed = true;
    while (changed) {
      const candidates = collectKnownParameterCandidates({
        ir: ctx.ir,
        callSites,
        exactParameterTypes: validatedExact,
        seedFacts: knownFacts,
        externallyCallableInstances,
      });
      const nextFacts = materializeKnownParameterFacts(candidates);
      changed =
        serializeKnownParameterFacts(nextFacts) !==
        serializeKnownParameterFacts(knownFacts);
      knownFacts = nextFacts;
    }

    const validatedKnown = validateKnownParameterFacts({
      ir: ctx.ir,
      callSites,
      exactParameterTypes: validatedExact,
      facts: knownFacts,
    });
    const receiverSpecializationRequests =
      collectReceiverSpecializationRequests({
        ir: ctx.ir,
        callSites,
        exactParameterTypes: validatedExact,
      });
    const previousExact = ctx.ir.facts.exactParameterTypes;
    const previousKnown = ctx.ir.facts.knownParameterTypes;
    const previousReceiverSpecializationRequests =
      ctx.ir.facts.receiverSpecializationRequests;
    const unchanged =
      serializeExactParameterFacts(previousExact) ===
        serializeExactParameterFacts(validatedExact) &&
      serializeKnownParameterFacts(previousKnown) ===
        serializeKnownParameterFacts(validatedKnown) &&
      serializeReceiverSpecializationRequests(
        previousReceiverSpecializationRequests,
      ) ===
        serializeReceiverSpecializationRequests(receiverSpecializationRequests);
    ctx.mutateProducedFacts((mutation) => {
      mutation.setFact("exactParameterTypes", validatedExact);
      mutation.setFact("knownParameterTypes", validatedKnown);
      mutation.setFact(
        "receiverSpecializationRequests",
        receiverSpecializationRequests,
      );
    });
    const exactParameterFacts = Array.from(validatedExact.values()).reduce(
      (count, bySymbol) => count + bySymbol.size,
      0,
    );
    const knownParameterFacts = Array.from(validatedKnown.values()).reduce(
      (count, bySymbol) => count + bySymbol.size,
      0,
    );
    const specializationRequests = Array.from(
      receiverSpecializationRequests.values(),
    ).reduce((count, byContext) => count + byContext.size, 0);
    return {
      changed: !unchanged,
      metrics: {
        exact_parameter_facts: exactParameterFacts,
        known_parameter_facts: knownParameterFacts,
        receiver_specialization_requests: specializationRequests,
      },
    };
  },
};
