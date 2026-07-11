import type { HirExpression, HirFunction } from "../../semantics/hir/index.js";
import type { CodegenFunctionSignature } from "../../semantics/codegen-view/index.js";
import type {
  HirExprId,
  ProgramFunctionInstanceId,
  SymbolId,
  TypeId,
} from "../../semantics/ids.js";
import { type ProgramOptimizationPass } from "../pass.js";
import type {
  EscapeAnalysisEscapeReason,
  EscapeAnalysisOriginFact,
  EscapeAnalysisOriginKind,
  EscapeAnalysisParameterFact,
  ReadonlyOptimizedModuleView,
} from "../ir.js";
import { type ProgramOptimizationIR } from "../ir.js";
import {
  exprTypeFor,
  resolveCallTypeArgs,
  resolveCallArgPlan,
  callArgumentExprIdForParameter,
  collectHandlerCaptures,
  functionItemBySymbol,
  InstanceCallSiteIndex,
  buildInstanceCallSiteIndex,
  callArgumentExprIds,
  resolveDirectIdentifierCallTarget,
  resolveTargetsForExactPropagation,
  externallyCallableFunctionInstances,
  moduleLetBySymbol,
  resolveTargetsForCaller,
} from "./shared.js";

export type MutableEscapeOriginFact = {
  originKind: EscapeAnalysisOriginKind;
  typeId?: TypeId;
  escapes: boolean;
  escapeReasons: Set<EscapeAnalysisEscapeReason>;
  directLocalSymbols: Set<SymbolId>;
  useExprIds: Set<HirExprId>;
};

export type MutableEscapeParameterFact = {
  escapes: boolean;
  escapeReasons: Set<EscapeAnalysisEscapeReason>;
  useExprIds: Set<HirExprId>;
};

export type EscapeUseContext = {
  reason?: EscapeAnalysisEscapeReason;
  traitBoundary?: boolean;
};

export type StructuralEscapeField = {
  name: string;
  typeId: TypeId;
  optional: boolean;
};

export type EscapeAnalysisState = {
  ir: ProgramOptimizationIR;
  moduleView: ReadonlyOptimizedModuleView;
  callerInstanceId?: ProgramFunctionInstanceId;
  parameterSymbols: ReadonlySet<SymbolId>;
  parameterFacts: ReadonlyMap<
    ProgramFunctionInstanceId,
    ReadonlyMap<SymbolId, MutableEscapeParameterFact>
  >;
  mutableParameterFacts?: Map<SymbolId, MutableEscapeParameterFact>;
  mutableOriginFacts?: Map<string, Map<HirExprId, MutableEscapeOriginFact>>;
  localOrigins: Map<SymbolId, Set<HirExprId>>;
  localParameterAliases: Map<SymbolId, Set<SymbolId>>;
};

export const emptyEscapeUseContext: EscapeUseContext = {};

export const serializeMutableParameterFacts = (
  facts: ReadonlyMap<
    ProgramFunctionInstanceId,
    ReadonlyMap<SymbolId, MutableEscapeParameterFact>
  >,
): string =>
  JSON.stringify(
    Array.from(facts.entries())
      .sort(([left], [right]) => left - right)
      .map(([instanceId, bySymbol]) => [
        instanceId,
        Array.from(bySymbol.entries())
          .sort(([left], [right]) => left - right)
          .map(([symbol, fact]) => [
            symbol,
            fact.escapes,
            Array.from(fact.escapeReasons).sort(),
            Array.from(fact.useExprIds).sort((left, right) => left - right),
          ]),
      ]),
  );

export const toImmutableParameterFacts = (
  facts: ReadonlyMap<
    ProgramFunctionInstanceId,
    ReadonlyMap<SymbolId, MutableEscapeParameterFact>
  >,
): Map<ProgramFunctionInstanceId, Map<SymbolId, EscapeAnalysisParameterFact>> =>
  new Map(
    Array.from(facts.entries()).map(([instanceId, bySymbol]) => [
      instanceId,
      new Map(
        Array.from(bySymbol.entries()).map(([symbol, fact]) => [
          symbol,
          {
            escapes: fact.escapes,
            escapeReasons: Array.from(fact.escapeReasons).sort(),
            useExprIds: Array.from(fact.useExprIds).sort(
              (left, right) => left - right,
            ),
          },
        ]),
      ),
    ]),
  );

export const toImmutableOriginFacts = (
  facts: ReadonlyMap<string, ReadonlyMap<HirExprId, MutableEscapeOriginFact>>,
): Map<string, Map<HirExprId, EscapeAnalysisOriginFact>> =>
  new Map(
    Array.from(facts.entries()).map(([moduleId, byExpr]) => [
      moduleId,
      new Map(
        Array.from(byExpr.entries()).map(([exprId, fact]) => [
          exprId,
          {
            originKind: fact.originKind,
            typeId: fact.typeId,
            escapes: fact.escapes,
            escapeReasons: Array.from(fact.escapeReasons).sort(),
            directLocalSymbols: Array.from(fact.directLocalSymbols).sort(
              (left, right) => left - right,
            ),
            useExprIds: Array.from(fact.useExprIds).sort(
              (left, right) => left - right,
            ),
          },
        ]),
      ),
    ]),
  );

export const mutableParameterFactFor = ({
  facts,
  instanceId,
  symbol,
}: {
  facts: Map<
    ProgramFunctionInstanceId,
    Map<SymbolId, MutableEscapeParameterFact>
  >;
  instanceId: ProgramFunctionInstanceId;
  symbol: SymbolId;
}): MutableEscapeParameterFact => {
  const bySymbol =
    facts.get(instanceId) ?? new Map<SymbolId, MutableEscapeParameterFact>();
  const fact = bySymbol.get(symbol) ?? {
    escapes: false,
    escapeReasons: new Set<EscapeAnalysisEscapeReason>(),
    useExprIds: new Set<HirExprId>(),
  };
  bySymbol.set(symbol, fact);
  facts.set(instanceId, bySymbol);
  return fact;
};

export const markParameterUse = ({
  fact,
  exprId,
  reason,
}: {
  fact: MutableEscapeParameterFact;
  exprId: HirExprId;
  reason?: EscapeAnalysisEscapeReason;
}): void => {
  fact.useExprIds.add(exprId);
  if (!reason) {
    return;
  }
  fact.escapes = true;
  fact.escapeReasons.add(reason);
};

export const markOriginUse = ({
  fact,
  exprId,
  reason,
  traitBoundary,
}: {
  fact: MutableEscapeOriginFact;
  exprId: HirExprId;
  reason?: EscapeAnalysisEscapeReason;
  traitBoundary?: boolean;
}): void => {
  fact.useExprIds.add(exprId);
  if (traitBoundary && fact.originKind === "aggregate") {
    fact.originKind = "trait-object";
  }
  const effectiveReason =
    fact.originKind === "effect-environment" &&
    reason !== "handler-resumption-escape"
      ? undefined
      : reason;
  if (!effectiveReason) {
    return;
  }
  fact.escapes = true;
  fact.escapeReasons.add(effectiveReason);
};

export const originKindForExpr = ({
  moduleView,
  exprId,
  ir,
}: {
  moduleView: ReadonlyOptimizedModuleView;
  exprId: HirExprId;
  ir: ProgramOptimizationIR;
}): EscapeAnalysisOriginKind | undefined => {
  const expr = moduleView.hir.expressions.get(exprId);
  if (!expr) {
    return undefined;
  }
  if (expr.exprKind === "lambda") {
    return "closure-environment";
  }
  if (expr.exprKind === "effect-handler") {
    return "effect-environment";
  }
  if (expr.exprKind !== "object-literal" && expr.exprKind !== "tuple") {
    return undefined;
  }

  const typeId = exprTypeFor({ moduleView, exprId });
  if (typeof typeId !== "number") {
    return "aggregate";
  }
  const desc = ir.baseProgram.types.getTypeDesc(typeId);
  return desc.kind === "trait" ||
    (desc.kind === "intersection" && (desc.traits?.length ?? 0) > 0)
    ? "trait-object"
    : "aggregate";
};

export const ensureOriginFact = ({
  state,
  exprId,
}: {
  state: EscapeAnalysisState;
  exprId: HirExprId;
}): MutableEscapeOriginFact | undefined => {
  const originKind = originKindForExpr({
    moduleView: state.moduleView,
    exprId,
    ir: state.ir,
  });
  if (!originKind || !state.mutableOriginFacts) {
    return undefined;
  }
  const byModule =
    state.mutableOriginFacts.get(state.moduleView.moduleId) ??
    new Map<HirExprId, MutableEscapeOriginFact>();
  const existing = byModule.get(exprId);
  if (existing) {
    return existing;
  }
  const typeId = exprTypeFor({ moduleView: state.moduleView, exprId });
  const fact: MutableEscapeOriginFact = {
    originKind,
    typeId,
    escapes: false,
    escapeReasons: new Set(),
    directLocalSymbols: new Set(),
    useExprIds: new Set(),
  };
  byModule.set(exprId, fact);
  state.mutableOriginFacts.set(state.moduleView.moduleId, byModule);
  return fact;
};

export const localOriginsForSymbol = ({
  state,
  symbol,
}: {
  state: EscapeAnalysisState;
  symbol: SymbolId;
}): ReadonlySet<HirExprId> | undefined => state.localOrigins.get(symbol);

export const bindLocalOrigin = ({
  state,
  symbol,
  originExprId,
}: {
  state: EscapeAnalysisState;
  symbol: SymbolId;
  originExprId: HirExprId;
}): void => {
  const origins = state.localOrigins.get(symbol) ?? new Set<HirExprId>();
  origins.add(originExprId);
  state.localOrigins.set(symbol, origins);
  const fact = ensureOriginFact({ state, exprId: originExprId });
  fact?.directLocalSymbols.add(symbol);
};

export const localParameterAliasesForSymbol = ({
  state,
  symbol,
}: {
  state: EscapeAnalysisState;
  symbol: SymbolId;
}): ReadonlySet<SymbolId> | undefined =>
  state.localParameterAliases.get(symbol);

export const unionInto = <T>(
  target: Set<T>,
  values: Iterable<T> | undefined,
): void => {
  if (!values) {
    return;
  }
  Array.from(values).forEach((value) => target.add(value));
};

export const parameterAliasesForInitializer = ({
  state,
  exprId,
}: {
  state: EscapeAnalysisState;
  exprId: HirExprId;
}): Set<SymbolId> => {
  const expr = state.moduleView.hir.expressions.get(exprId);
  if (!expr) {
    return new Set();
  }
  if (expr.exprKind === "identifier") {
    return new Set([
      ...(state.parameterSymbols.has(expr.symbol) ? [expr.symbol] : []),
      ...(localParameterAliasesForSymbol({ state, symbol: expr.symbol }) ?? []),
    ]);
  }
  if (expr.exprKind === "block") {
    return typeof expr.value === "number"
      ? parameterAliasesForInitializer({ state, exprId: expr.value })
      : new Set();
  }
  if (expr.exprKind === "if" || expr.exprKind === "cond") {
    const aliases = new Set<SymbolId>();
    expr.branches.forEach((branch) => {
      unionInto(
        aliases,
        parameterAliasesForInitializer({ state, exprId: branch.value }),
      );
    });
    if (typeof expr.defaultBranch === "number") {
      unionInto(
        aliases,
        parameterAliasesForInitializer({ state, exprId: expr.defaultBranch }),
      );
    }
    return aliases;
  }
  if (expr.exprKind === "match") {
    const aliases = new Set<SymbolId>();
    expr.arms.forEach((arm) => {
      unionInto(
        aliases,
        parameterAliasesForInitializer({ state, exprId: arm.value }),
      );
    });
    return aliases;
  }
  if (expr.exprKind === "effect-handler") {
    const aliases = parameterAliasesForInitializer({
      state,
      exprId: expr.body,
    });
    expr.handlers.forEach((handler) => {
      unionInto(
        aliases,
        parameterAliasesForInitializer({ state, exprId: handler.body }),
      );
    });
    if (typeof expr.finallyBranch === "number") {
      unionInto(
        aliases,
        parameterAliasesForInitializer({ state, exprId: expr.finallyBranch }),
      );
    }
    return aliases;
  }
  return new Set();
};

export const bindLocalParameterAliases = ({
  state,
  symbol,
  parameterSymbols,
}: {
  state: EscapeAnalysisState;
  symbol: SymbolId;
  parameterSymbols: ReadonlySet<SymbolId>;
}): void => {
  if (parameterSymbols.size === 0) {
    return;
  }
  const aliases =
    state.localParameterAliases.get(symbol) ?? new Set<SymbolId>();
  parameterSymbols.forEach((parameterSymbol) => aliases.add(parameterSymbol));
  state.localParameterAliases.set(symbol, aliases);
};

export const markSymbolUse = ({
  state,
  symbol,
  exprId,
  context,
}: {
  state: EscapeAnalysisState;
  symbol: SymbolId;
  exprId: HirExprId;
  context: EscapeUseContext;
}): void => {
  const origins = localOriginsForSymbol({ state, symbol });
  origins?.forEach((originExprId) => {
    const fact = ensureOriginFact({ state, exprId: originExprId });
    if (!fact) {
      return;
    }
    markOriginUse({
      fact,
      exprId,
      reason: context.reason,
      traitBoundary: context.traitBoundary,
    });
  });

  const parameterSymbols = new Set([
    ...(state.parameterSymbols.has(symbol) ? [symbol] : []),
    ...(localParameterAliasesForSymbol({ state, symbol }) ?? []),
  ]);
  parameterSymbols.forEach((parameterSymbol) => {
    const fact = state.mutableParameterFacts?.get(parameterSymbol);
    if (!fact) {
      return;
    }
    markParameterUse({
      fact,
      exprId,
      reason: context.reason,
    });
  });
};

export const markSymbolSetUse = ({
  state,
  symbols,
  exprId,
  reason,
}: {
  state: EscapeAnalysisState;
  symbols: Iterable<SymbolId>;
  exprId: HirExprId;
  reason: EscapeAnalysisEscapeReason;
}): void => {
  Array.from(symbols).forEach((symbol) =>
    markSymbolUse({
      state,
      symbol,
      exprId,
      context: { reason },
    }),
  );
};

export const originExprIdsForInitializer = ({
  state,
  exprId,
}: {
  state: EscapeAnalysisState;
  exprId: HirExprId;
}): Set<HirExprId> => {
  const expr = state.moduleView.hir.expressions.get(exprId);
  if (!expr) {
    return new Set();
  }
  if (expr.exprKind === "effect-handler") {
    const origins = new Set<HirExprId>([exprId]);
    unionInto(
      origins,
      originExprIdsForInitializer({ state, exprId: expr.body }),
    );
    expr.handlers.forEach((handler) => {
      unionInto(
        origins,
        originExprIdsForInitializer({ state, exprId: handler.body }),
      );
    });
    if (typeof expr.finallyBranch === "number") {
      unionInto(
        origins,
        originExprIdsForInitializer({ state, exprId: expr.finallyBranch }),
      );
    }
    return origins;
  }
  if (
    originKindForExpr({ moduleView: state.moduleView, exprId, ir: state.ir })
  ) {
    return new Set([exprId]);
  }
  if (expr.exprKind === "identifier") {
    return new Set(localOriginsForSymbol({ state, symbol: expr.symbol }) ?? []);
  }
  if (expr.exprKind === "block") {
    return typeof expr.value === "number"
      ? originExprIdsForInitializer({ state, exprId: expr.value })
      : new Set();
  }
  if (expr.exprKind === "if" || expr.exprKind === "cond") {
    const origins = new Set<HirExprId>();
    expr.branches.forEach((branch) => {
      unionInto(
        origins,
        originExprIdsForInitializer({ state, exprId: branch.value }),
      );
    });
    if (typeof expr.defaultBranch === "number") {
      unionInto(
        origins,
        originExprIdsForInitializer({ state, exprId: expr.defaultBranch }),
      );
    }
    return origins;
  }
  if (expr.exprKind === "match") {
    const origins = new Set<HirExprId>();
    expr.arms.forEach((arm) => {
      unionInto(
        origins,
        originExprIdsForInitializer({ state, exprId: arm.value }),
      );
    });
    return origins;
  }
  return new Set();
};

export const isTraitType = ({
  typeId,
  ir,
}: {
  typeId: TypeId | undefined;
  ir: ProgramOptimizationIR;
}): boolean => {
  if (typeof typeId !== "number") {
    return false;
  }
  const desc = ir.baseProgram.types.getTypeDesc(typeId);
  return (
    desc.kind === "trait" ||
    (desc.kind === "intersection" && (desc.traits?.length ?? 0) > 0)
  );
};

export const targetParameterIsMutable = ({
  state,
  moduleId,
  symbol,
  parameterIndex,
  parameter,
}: {
  state: EscapeAnalysisState;
  moduleId: string;
  symbol: SymbolId;
  parameterIndex: number;
  parameter: CodegenFunctionSignature["parameters"][number];
}): boolean => {
  if (parameter.bindingKind === "mutable-ref") {
    return true;
  }
  const moduleView = state.ir.modules.get(moduleId);
  const item = moduleView
    ? functionItemBySymbol({ ir: state.ir, moduleView, symbol })
    : undefined;
  return item?.parameters[parameterIndex]?.mutable === true;
};

export const structuralEscapeFieldsForType = ({
  typeId,
  state,
  seen = new Set<TypeId>(),
}: {
  typeId: TypeId;
  state: EscapeAnalysisState;
  seen?: Set<TypeId>;
}): readonly StructuralEscapeField[] | undefined => {
  if (seen.has(typeId)) {
    return undefined;
  }
  seen.add(typeId);

  const layout = state.ir.baseProgram.types.getStructuralLayout(typeId);
  if (layout?.kind === "structural-object") {
    return layout.fields;
  }

  const objectInfo = state.ir.baseProgram.objects.getInfoByNominal(typeId);
  if (objectInfo) {
    return objectInfo.fields.map((field) => ({
      name: field.name,
      typeId: field.type,
      optional: field.optional === true,
    }));
  }

  const desc = state.ir.baseProgram.types.getTypeDesc(typeId);
  if (desc.kind === "intersection") {
    const structural =
      typeof desc.structural === "number"
        ? structuralEscapeFieldsForType({
            typeId: desc.structural,
            state,
            seen,
          })
        : undefined;
    if (structural) {
      return structural;
    }
    return typeof desc.nominal === "number"
      ? structuralEscapeFieldsForType({ typeId: desc.nominal, state, seen })
      : undefined;
  }

  return undefined;
};

export const parameterCanBeOmittedAtCallSite = ({
  parameter,
  moduleId,
  state,
}: {
  parameter: CodegenFunctionSignature["parameters"][number];
  moduleId: string;
  state: EscapeAnalysisState;
}): boolean =>
  parameter.optional === true ||
  parameter.synthetic === "stable-callsite-id" ||
  state.ir.baseProgram.optionals.getOptionalInfo(moduleId, parameter.typeId) !==
    undefined;

export const callLabelsCompatible = ({
  parameter,
  argLabel,
}: {
  parameter: CodegenFunctionSignature["parameters"][number];
  argLabel: string | undefined;
}): boolean =>
  parameter.label ? argLabel === parameter.label : argLabel === undefined;

export const fallbackContainerFieldParameterIndexesForCallArgument = ({
  expr,
  argIndex,
  signature,
  moduleId,
  state,
}: {
  expr: Extract<HirExpression, { exprKind: "call" | "method-call" }>;
  argIndex: number;
  signature: CodegenFunctionSignature;
  moduleId: string;
  state: EscapeAnalysisState;
}): readonly number[] | undefined => {
  if (expr.exprKind !== "call") {
    return undefined;
  }

  const targetArg = expr.args[argIndex];
  if (!targetArg || targetArg.label !== undefined) {
    return undefined;
  }

  const targetArgTypeId = exprTypeFor({
    moduleView: state.moduleView,
    exprId: targetArg.expr,
  });
  if (typeof targetArgTypeId !== "number") {
    return undefined;
  }

  const targetFields = structuralEscapeFieldsForType({
    typeId: targetArgTypeId,
    state,
  });
  if (!targetFields) {
    return undefined;
  }
  const fieldsByName = new Map(
    targetFields.map((field) => [field.name, field]),
  );

  const parameterIndexes: number[] = [];
  let cursorArgIndex = 0;
  let cursorParameterIndex = 0;

  while (cursorParameterIndex < signature.parameters.length) {
    const parameter = signature.parameters[cursorParameterIndex]!;
    const arg = expr.args[cursorArgIndex];

    if (!arg) {
      if (parameterCanBeOmittedAtCallSite({ parameter, moduleId, state })) {
        cursorParameterIndex += 1;
        continue;
      }
      return undefined;
    }

    if (parameter.label && arg.label === undefined) {
      const argTypeId = exprTypeFor({
        moduleView: state.moduleView,
        exprId: arg.expr,
      });
      if (typeof argTypeId !== "number") {
        return undefined;
      }

      const fields = structuralEscapeFieldsForType({
        typeId: argTypeId,
        state,
      });
      const fieldMap = fields
        ? new Map(fields.map((field) => [field.name, field]))
        : undefined;
      if (fieldMap) {
        let nextParameterIndex = cursorParameterIndex;
        const containerParameterIndexes: number[] = [];
        while (nextParameterIndex < signature.parameters.length) {
          const runParameter = signature.parameters[nextParameterIndex]!;
          if (!runParameter.label) {
            break;
          }

          if (fieldMap.has(runParameter.label)) {
            containerParameterIndexes.push(nextParameterIndex);
            nextParameterIndex += 1;
            continue;
          }

          if (
            parameterCanBeOmittedAtCallSite({
              parameter: runParameter,
              moduleId,
              state,
            })
          ) {
            nextParameterIndex += 1;
            continue;
          }

          return undefined;
        }

        if (nextParameterIndex > cursorParameterIndex) {
          if (cursorArgIndex === argIndex) {
            if (containerParameterIndexes.length === 0) {
              return undefined;
            }
            parameterIndexes.push(...containerParameterIndexes);
          }
          cursorParameterIndex = nextParameterIndex;
          cursorArgIndex += 1;
          continue;
        }
      }
    }

    if (callLabelsCompatible({ parameter, argLabel: arg.label })) {
      if (cursorArgIndex === argIndex) {
        return undefined;
      }
      cursorParameterIndex += 1;
      cursorArgIndex += 1;
      continue;
    }

    if (parameterCanBeOmittedAtCallSite({ parameter, moduleId, state })) {
      cursorParameterIndex += 1;
      continue;
    }

    return undefined;
  }

  if (cursorArgIndex < expr.args.length) {
    return undefined;
  }

  return parameterIndexes.length > 0 &&
    parameterIndexes.every((index) =>
      fieldsByName.has(signature.parameters[index]!.label!),
    )
    ? parameterIndexes
    : undefined;
};

export const contextForCallArgument = ({
  moduleView,
  exprId,
  expr,
  argExprId,
  argIndex,
  state,
}: {
  moduleView: ReadonlyOptimizedModuleView;
  exprId: HirExprId;
  expr: Extract<HirExpression, { exprKind: "call" | "method-call" }>;
  argExprId: HirExprId;
  argIndex: number;
  state: EscapeAnalysisState;
}): EscapeUseContext => {
  const callInfo = state.ir.calls.get(moduleView.moduleId)?.get(exprId);
  if (callInfo?.traitDispatch) {
    return {
      reason: argIndex === 0 ? "dynamic-dispatch" : "call-boundary",
      traitBoundary: argIndex === 0,
    };
  }

  const resolvedTargets =
    typeof state.callerInstanceId === "number"
      ? resolveTargetsForExactPropagation({
          moduleView,
          exprId,
          expr,
          callerInstanceId: state.callerInstanceId,
          ir: state.ir,
        })
      : resolveTargetsForCaller({
          moduleId: moduleView.moduleId,
          exprId,
          callerInstanceId: state.callerInstanceId,
          ir: state.ir,
        });
  const targets =
    resolvedTargets.length > 0
      ? resolvedTargets
      : resolveDirectIdentifierCallTarget({
          moduleView,
          expr,
          typeArgs: callInfo
            ? resolveCallTypeArgs({
                callInfo,
                callerInstanceId: state.callerInstanceId,
              })
            : [],
          ir: state.ir,
        });
  if (targets.length === 0) {
    return { reason: "unknown" };
  }

  const argPlan = callInfo
    ? resolveCallArgPlan({ callInfo, callerInstanceId: state.callerInstanceId })
    : undefined;
  const containerFieldEntries =
    argPlan?.flatMap((entry, parameterIndex) =>
      entry.kind === "container-field" && entry.containerArgIndex === argIndex
        ? [{ entry, parameterIndex }]
        : [],
    ) ?? [];
  const argIsOnlyContainerFields =
    containerFieldEntries.length > 0 &&
    argPlan?.every((entry) =>
      entry.kind === "container-field"
        ? entry.containerArgIndex === argIndex ||
          entry.containerArgIndex !== argIndex
        : entry.kind !== "direct" || entry.argIndex !== argIndex,
    ) === true;
  if (argIsOnlyContainerFields) {
    let unsafeReason: EscapeAnalysisEscapeReason | undefined;
    targets.forEach(({ instanceId }) => {
      if (unsafeReason || typeof instanceId !== "number") {
        unsafeReason = unsafeReason ?? "unknown";
        return;
      }
      const target = state.ir.baseProgram.functions.getInstance(instanceId);
      const signature = state.ir.baseProgram.functions.getSignature(
        target.symbolRef.moduleId,
        target.symbolRef.symbol,
      );
      if (!signature) {
        unsafeReason = "unknown";
        return;
      }
      if (!state.ir.baseProgram.effects.isEmpty(signature.effectRow)) {
        unsafeReason = "effectful-call";
        return;
      }
      containerFieldEntries.forEach(({ parameterIndex }) => {
        if (unsafeReason) {
          return;
        }
        const parameter = signature.parameters[parameterIndex];
        if (!parameter || typeof parameter.symbol !== "number") {
          unsafeReason = "unknown";
          return;
        }
        if (
          targetParameterIsMutable({
            state,
            moduleId: target.symbolRef.moduleId,
            symbol: target.symbolRef.symbol,
            parameterIndex,
            parameter,
          })
        ) {
          unsafeReason = "mutable-call-argument";
          return;
        }
      });
    });
    if (!unsafeReason) {
      return {};
    }
  }
  if (!argPlan) {
    let unsafeReason: EscapeAnalysisEscapeReason | undefined;
    targets.forEach(({ instanceId }) => {
      if (unsafeReason || typeof instanceId !== "number") {
        unsafeReason = unsafeReason ?? "unknown";
        return;
      }
      const target = state.ir.baseProgram.functions.getInstance(instanceId);
      const signature = state.ir.baseProgram.functions.getSignature(
        target.symbolRef.moduleId,
        target.symbolRef.symbol,
      );
      if (!signature) {
        unsafeReason = "unknown";
        return;
      }
      if (!state.ir.baseProgram.effects.isEmpty(signature.effectRow)) {
        unsafeReason = "effectful-call";
        return;
      }
      const parameterIndexes =
        fallbackContainerFieldParameterIndexesForCallArgument({
          expr,
          argIndex,
          signature,
          moduleId: target.symbolRef.moduleId,
          state,
        });
      if (!parameterIndexes) {
        unsafeReason = "unknown";
        return;
      }
      parameterIndexes.forEach((parameterIndex) => {
        if (unsafeReason) {
          return;
        }
        const parameter = signature.parameters[parameterIndex];
        if (!parameter || typeof parameter.symbol !== "number") {
          unsafeReason = "unknown";
          return;
        }
        if (
          targetParameterIsMutable({
            state,
            moduleId: target.symbolRef.moduleId,
            symbol: target.symbolRef.symbol,
            parameterIndex,
            parameter,
          })
        ) {
          unsafeReason = "mutable-call-argument";
          return;
        }
      });
    });
    if (!unsafeReason) {
      return {};
    }
  }

  let traitBoundary = false;
  let unsafeReason: EscapeAnalysisEscapeReason | undefined;
  targets.forEach(({ instanceId }) => {
    if (unsafeReason || typeof instanceId !== "number") {
      unsafeReason = unsafeReason ?? "unknown";
      return;
    }
    const target = state.ir.baseProgram.functions.getInstance(instanceId);
    const signature = state.ir.baseProgram.functions.getSignature(
      target.symbolRef.moduleId,
      target.symbolRef.symbol,
    );
    if (!signature) {
      unsafeReason = "unknown";
      return;
    }
    if (!state.ir.baseProgram.effects.isEmpty(signature.effectRow)) {
      unsafeReason = "effectful-call";
      return;
    }

    const parameterIndex =
      typeof state.callerInstanceId === "number"
        ? signature.parameters.findIndex((_parameter, index) => {
            const mappedArgExprId = callArgumentExprIdForParameter({
              argExprIds: callArgumentExprIds(expr),
              callInfo,
              callerInstanceId: state.callerInstanceId!,
              parameterIndex: index,
            });
            return mappedArgExprId === argExprId;
          })
        : argIndex;
    const parameter = signature.parameters[parameterIndex];
    if (!parameter || typeof parameter.symbol !== "number") {
      unsafeReason = "unknown";
      return;
    }
    traitBoundary =
      traitBoundary || isTraitType({ typeId: parameter.typeId, ir: state.ir });
    if (
      targetParameterIsMutable({
        state,
        moduleId: target.symbolRef.moduleId,
        symbol: target.symbolRef.symbol,
        parameterIndex,
        parameter,
      })
    ) {
      unsafeReason = "mutable-call-argument";
      return;
    }
    const targetFact = state.parameterFacts
      .get(instanceId)
      ?.get(parameter.symbol);
    if (!targetFact || targetFact.escapes) {
      unsafeReason = "call-boundary";
    }
  });

  return unsafeReason
    ? { reason: unsafeReason, traitBoundary }
    : { traitBoundary };
};

export const analyzeEscapeExpression = ({
  exprId,
  context,
  state,
}: {
  exprId: HirExprId;
  context: EscapeUseContext;
  state: EscapeAnalysisState;
}): void => {
  const expr = state.moduleView.hir.expressions.get(exprId);
  if (!expr) {
    return;
  }

  const originFact = ensureOriginFact({ state, exprId });
  if (originFact) {
    markOriginUse({
      fact: originFact,
      exprId,
      reason: context.reason,
      traitBoundary: context.traitBoundary,
    });
  }

  switch (expr.exprKind) {
    case "literal":
    case "overload-set":
    case "continue":
      return;
    case "identifier":
      markSymbolUse({ state, symbol: expr.symbol, exprId, context });
      return;
    case "block": {
      expr.statements.forEach((statementId) =>
        analyzeEscapeStatement({ statementId, state }),
      );
      if (typeof expr.value === "number") {
        analyzeEscapeExpression({ exprId: expr.value, context, state });
      }
      return;
    }
    case "tuple":
      expr.elements.forEach((element) =>
        analyzeEscapeExpression({
          exprId: element,
          context: { reason: "stored-in-aggregate" },
          state,
        }),
      );
      return;
    case "object-literal":
      expr.entries.forEach((entry) =>
        analyzeEscapeExpression({
          exprId: entry.value,
          context: { reason: "stored-in-aggregate" },
          state,
        }),
      );
      return;
    case "field-access":
      analyzeEscapeExpression({
        exprId: expr.target,
        context: emptyEscapeUseContext,
        state,
      });
      return;
    case "assign": {
      if (typeof expr.target === "number") {
        const target = state.moduleView.hir.expressions.get(expr.target);
        if (target?.exprKind === "field-access") {
          analyzeEscapeExpression({
            exprId: target.target,
            context: emptyEscapeUseContext,
            state,
          });
        } else {
          analyzeEscapeExpression({
            exprId: expr.target,
            context: { reason: "assignment" },
            state,
          });
        }
      }
      analyzeEscapeExpression({
        exprId: expr.value,
        context: { reason: "assignment" },
        state,
      });
      return;
    }
    case "call":
    case "method-call": {
      if (expr.exprKind === "call") {
        analyzeEscapeExpression({
          exprId: expr.callee,
          context: emptyEscapeUseContext,
          state,
        });
      }
      callArgumentExprIds(expr).forEach((argExprId, argIndex) =>
        analyzeEscapeExpression({
          exprId: argExprId,
          context: contextForCallArgument({
            moduleView: state.moduleView,
            exprId,
            expr,
            argExprId,
            argIndex,
            state,
          }),
          state,
        }),
      );
      return;
    }
    case "lambda":
      markSymbolSetUse({
        state,
        symbols: expr.captures.map((capture) => capture.symbol),
        exprId,
        reason: "closure-capture",
      });
      return;
    case "effect-handler": {
      analyzeEscapeExpression({ exprId: expr.body, context, state });
      const captures = collectHandlerCaptures({
        moduleView: state.moduleView,
      }).get(expr.id);
      captures?.forEach((symbols) =>
        markSymbolSetUse({
          state,
          symbols,
          exprId: expr.id,
          reason: "effect-handler-capture",
        }),
      );
      expr.handlers.forEach((handler) => {
        if (handler.tailResumption?.escapes) {
          const fact = ensureOriginFact({ state, exprId: expr.id });
          if (fact) {
            markOriginUse({
              fact,
              exprId: expr.id,
              reason: "handler-resumption-escape",
            });
          }
        }
        analyzeEscapeExpression({
          exprId: handler.body,
          context: emptyEscapeUseContext,
          state,
        });
      });
      if (typeof expr.finallyBranch === "number") {
        analyzeEscapeExpression({
          exprId: expr.finallyBranch,
          context: emptyEscapeUseContext,
          state,
        });
      }
      return;
    }
    case "loop":
      analyzeEscapeExpression({
        exprId: expr.body,
        context: emptyEscapeUseContext,
        state,
      });
      return;
    case "while":
      analyzeEscapeExpression({
        exprId: expr.condition,
        context: emptyEscapeUseContext,
        state,
      });
      analyzeEscapeExpression({
        exprId: expr.body,
        context: emptyEscapeUseContext,
        state,
      });
      return;
    case "if":
    case "cond":
      expr.branches.forEach((branch) => {
        analyzeEscapeExpression({
          exprId: branch.condition,
          context: emptyEscapeUseContext,
          state,
        });
        analyzeEscapeExpression({ exprId: branch.value, context, state });
      });
      if (typeof expr.defaultBranch === "number") {
        analyzeEscapeExpression({ exprId: expr.defaultBranch, context, state });
      }
      return;
    case "match":
      analyzeEscapeExpression({
        exprId: expr.discriminant,
        context: emptyEscapeUseContext,
        state,
      });
      expr.arms.forEach((arm) => {
        if (typeof arm.guard === "number") {
          analyzeEscapeExpression({
            exprId: arm.guard,
            context: emptyEscapeUseContext,
            state,
          });
        }
        analyzeEscapeExpression({ exprId: arm.value, context, state });
      });
      return;
    case "break":
      if (typeof expr.value === "number") {
        analyzeEscapeExpression({
          exprId: expr.value,
          context: emptyEscapeUseContext,
          state,
        });
      }
      return;
  }
};

export const analyzeEscapeStatement = ({
  statementId,
  state,
}: {
  statementId: number;
  state: EscapeAnalysisState;
}): void => {
  const statement = state.moduleView.hir.statements.get(statementId);
  if (!statement) {
    return;
  }
  if (statement.kind === "expr-stmt") {
    analyzeEscapeExpression({
      exprId: statement.expr,
      context: emptyEscapeUseContext,
      state,
    });
    return;
  }
  if (statement.kind === "return") {
    if (typeof statement.value === "number") {
      analyzeEscapeExpression({
        exprId: statement.value,
        context: { reason: "return" },
        state,
      });
    }
    return;
  }

  if (statement.pattern.kind === "identifier") {
    const boundSymbol = statement.pattern.symbol;
    analyzeEscapeExpression({
      exprId: statement.initializer,
      context: emptyEscapeUseContext,
      state,
    });

    const boundOrigins = originExprIdsForInitializer({
      state,
      exprId: statement.initializer,
    });
    boundOrigins.forEach((originExprId) => {
      bindLocalOrigin({
        state,
        symbol: boundSymbol,
        originExprId,
      });
    });
    bindLocalParameterAliases({
      state,
      symbol: boundSymbol,
      parameterSymbols: parameterAliasesForInitializer({
        state,
        exprId: statement.initializer,
      }),
    });
    return;
  }

  analyzeEscapeExpression({
    exprId: statement.initializer,
    context: emptyEscapeUseContext,
    state,
  });
};

export const parameterSymbolsForFunction = (item: HirFunction): Set<SymbolId> =>
  new Set(item.parameters.map((parameter) => parameter.symbol));

export const seedParameterFacts = ({
  ir,
  externalInstances,
}: {
  ir: ProgramOptimizationIR;
  externalInstances: ReadonlySet<ProgramFunctionInstanceId>;
}): Map<
  ProgramFunctionInstanceId,
  Map<SymbolId, MutableEscapeParameterFact>
> => {
  const facts = new Map<
    ProgramFunctionInstanceId,
    Map<SymbolId, MutableEscapeParameterFact>
  >();
  ir.facts.reachableFunctionInstances.forEach((instanceId) => {
    const instance = ir.baseProgram.functions.getInstance(instanceId);
    const signature = ir.baseProgram.functions.getSignature(
      instance.symbolRef.moduleId,
      instance.symbolRef.symbol,
    );
    signature?.parameters.forEach((parameter) => {
      if (typeof parameter.symbol !== "number") {
        return;
      }
      const fact = mutableParameterFactFor({
        facts,
        instanceId,
        symbol: parameter.symbol,
      });
      if (externalInstances.has(instanceId)) {
        fact.escapes = true;
        fact.escapeReasons.add("public-boundary");
      }
    });
  });
  return facts;
};

export const analyzeParameterEscapes = ({
  ir,
  instanceId,
  facts,
}: {
  ir: ProgramOptimizationIR;
  instanceId: ProgramFunctionInstanceId;
  facts: Map<
    ProgramFunctionInstanceId,
    Map<SymbolId, MutableEscapeParameterFact>
  >;
}): void => {
  const instance = ir.baseProgram.functions.getInstance(instanceId);
  const moduleView = ir.modules.get(instance.symbolRef.moduleId);
  const item = moduleView
    ? functionItemBySymbol({
        ir,
        moduleView,
        symbol: instance.symbolRef.symbol,
      })
    : undefined;
  const mutableParameterFacts = facts.get(instanceId);
  if (!moduleView || !item || !mutableParameterFacts) {
    return;
  }
  analyzeEscapeExpression({
    exprId: item.body,
    context: { reason: "return" },
    state: {
      ir,
      moduleView,
      callerInstanceId: instanceId,
      parameterSymbols: parameterSymbolsForFunction(item),
      parameterFacts: facts,
      mutableParameterFacts,
      localOrigins: new Map(),
      localParameterAliases: new Map(),
    },
  });
};

export const serializeMutableParameterFactsForInstance = (
  instanceId: ProgramFunctionInstanceId,
  bySymbol: ReadonlyMap<SymbolId, MutableEscapeParameterFact> | undefined,
): string =>
  serializeMutableParameterFacts(
    bySymbol ? new Map([[instanceId, bySymbol]]) : new Map(),
  );

export const buildParameterEscapeCallers = ({
  ir,
  callSites,
}: {
  ir: ProgramOptimizationIR;
  callSites: InstanceCallSiteIndex;
}): Map<ProgramFunctionInstanceId, Set<ProgramFunctionInstanceId>> => {
  const callersByTarget = new Map<
    ProgramFunctionInstanceId,
    Set<ProgramFunctionInstanceId>
  >();
  callSites.forEach((sites, callerInstanceId) => {
    sites.forEach(({ moduleView, exprId, expr }) => {
      resolveTargetsForExactPropagation({
        moduleView,
        exprId,
        expr,
        callerInstanceId,
        ir,
      }).forEach(({ instanceId: targetInstanceId }) => {
        if (typeof targetInstanceId !== "number") {
          return;
        }
        const callers = callersByTarget.get(targetInstanceId) ?? new Set();
        callers.add(callerInstanceId);
        callersByTarget.set(targetInstanceId, callers);
      });
    });
  });
  return callersByTarget;
};

export const computeParameterEscapeFacts = ({
  ir,
}: {
  ir: ProgramOptimizationIR;
}): {
  facts: Map<
    ProgramFunctionInstanceId,
    Map<SymbolId, MutableEscapeParameterFact>
  >;
  worklistPops: number;
  worklistRequeues: number;
} => {
  const externalInstances = externallyCallableFunctionInstances(ir);
  const facts = seedParameterFacts({ ir, externalInstances });
  const callSites = buildInstanceCallSiteIndex({ ir });
  const callersByTarget = buildParameterEscapeCallers({ ir, callSites });
  const queued = Array.from(ir.facts.reachableFunctionInstances);
  const queuedInstances = new Set(queued);
  let worklistPops = 0;
  let worklistRequeues = 0;

  const enqueue = (instanceId: ProgramFunctionInstanceId): void => {
    if (queuedInstances.has(instanceId)) {
      return;
    }
    queued.push(instanceId);
    queuedInstances.add(instanceId);
    worklistRequeues += 1;
  };

  while (queued.length > 0) {
    const instanceId = queued.pop()!;
    queuedInstances.delete(instanceId);
    worklistPops += 1;
    const before = serializeMutableParameterFactsForInstance(
      instanceId,
      facts.get(instanceId),
    );
    analyzeParameterEscapes({ ir, instanceId, facts });
    const after = serializeMutableParameterFactsForInstance(
      instanceId,
      facts.get(instanceId),
    );
    if (before === after) {
      continue;
    }
    callersByTarget
      .get(instanceId)
      ?.forEach((callerInstanceId) => enqueue(callerInstanceId));
  }

  return { facts, worklistPops, worklistRequeues };
};

export const computeOriginEscapeFacts = ({
  ir,
  parameterFacts,
}: {
  ir: ProgramOptimizationIR;
  parameterFacts: ReadonlyMap<
    ProgramFunctionInstanceId,
    ReadonlyMap<SymbolId, MutableEscapeParameterFact>
  >;
}): Map<string, Map<HirExprId, MutableEscapeOriginFact>> => {
  const originFacts = new Map<
    string,
    Map<HirExprId, MutableEscapeOriginFact>
  >();

  ir.facts.reachableFunctionInstances.forEach((instanceId) => {
    const instance = ir.baseProgram.functions.getInstance(instanceId);
    const moduleView = ir.modules.get(instance.symbolRef.moduleId);
    const item = moduleView
      ? functionItemBySymbol({
          ir,
          moduleView,
          symbol: instance.symbolRef.symbol,
        })
      : undefined;
    if (!moduleView || !item) {
      return;
    }
    analyzeEscapeExpression({
      exprId: item.body,
      context: { reason: "return" },
      state: {
        ir,
        moduleView,
        callerInstanceId: instanceId,
        parameterSymbols: parameterSymbolsForFunction(item),
        parameterFacts,
        mutableOriginFacts: originFacts,
        localOrigins: new Map(),
        localParameterAliases: new Map(),
      },
    });
  });

  ir.facts.reachableModuleLets.forEach((symbols, moduleId) => {
    const moduleView = ir.modules.get(moduleId);
    if (!moduleView) {
      return;
    }
    symbols.forEach((symbol) => {
      const moduleLet = moduleLetBySymbol({ ir, moduleView, symbol });
      if (!moduleLet) {
        return;
      }
      analyzeEscapeExpression({
        exprId: moduleLet.initializer,
        context: { reason: "module-let" },
        state: {
          ir,
          moduleView,
          parameterSymbols: new Set(),
          parameterFacts,
          mutableOriginFacts: originFacts,
          localOrigins: new Map(),
          localParameterAliases: new Map(),
        },
      });
    });
  });

  return originFacts;
};

export const serializeOriginFacts = (
  facts: ReadonlyMap<string, ReadonlyMap<HirExprId, EscapeAnalysisOriginFact>>,
): string =>
  JSON.stringify(
    Array.from(facts.entries())
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([moduleId, byExpr]) => [
        moduleId,
        Array.from(byExpr.entries())
          .sort(([left], [right]) => left - right)
          .map(([exprId, fact]) => [
            exprId,
            fact.originKind,
            fact.typeId,
            fact.escapes,
            fact.escapeReasons,
            fact.directLocalSymbols,
            fact.useExprIds,
          ]),
      ]),
  );

export const escapeAnalysisPass: ProgramOptimizationPass = {
  name: "whole-program-escape-analysis",
  run(ctx) {
    const ir = ctx.ir;
    const {
      facts: parameterFacts,
      worklistPops,
      worklistRequeues,
    } = computeParameterEscapeFacts({ ir });
    const originFacts = computeOriginEscapeFacts({ ir, parameterFacts });
    const immutableParameters = toImmutableParameterFacts(parameterFacts);
    const immutableOrigins = toImmutableOriginFacts(originFacts);
    const previous = ir.facts.escapeAnalysis;
    const changed =
      serializeMutableParameterFacts(parameterFacts) !==
        JSON.stringify(
          Array.from(previous.parameters.entries())
            .sort(([left], [right]) => left - right)
            .map(([instanceId, bySymbol]) => [
              instanceId,
              Array.from(bySymbol.entries())
                .sort(([left], [right]) => left - right)
                .map(([symbol, fact]) => [
                  symbol,
                  fact.escapes,
                  fact.escapeReasons,
                  fact.useExprIds,
                ]),
            ]),
        ) ||
      serializeOriginFacts(immutableOrigins) !==
        serializeOriginFacts(previous.origins);

    ctx.mutateProducedFacts((mutation) =>
      mutation.setFact("escapeAnalysis", {
        origins: immutableOrigins,
        parameters: immutableParameters,
      }),
    );

    const originValues = Array.from(immutableOrigins.values()).flatMap(
      (byExpr) => Array.from(byExpr.values()),
    );
    const parameterValues = Array.from(immutableParameters.values()).flatMap(
      (bySymbol) => Array.from(bySymbol.values()),
    );
    const metrics: Record<string, number> = {
      escaping_origins: originValues.filter((fact) => fact.escapes).length,
      non_escaping_origins: originValues.filter((fact) => !fact.escapes).length,
      escaping_parameters: parameterValues.filter((fact) => fact.escapes)
        .length,
      non_escaping_parameters: parameterValues.filter((fact) => !fact.escapes)
        .length,
      parameter_worklist_pops: worklistPops,
      parameter_worklist_requeues: worklistRequeues,
    };
    [...originValues, ...parameterValues].forEach((fact) => {
      fact.escapeReasons.forEach((reason) => {
        const metric = `escape_reason.${reason}`;
        metrics[metric] = (metrics[metric] ?? 0) + 1;
      });
    });

    return { changed, metrics };
  },
};
