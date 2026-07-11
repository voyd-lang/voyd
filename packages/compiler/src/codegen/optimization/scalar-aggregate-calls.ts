import binaryen from "binaryen";
import type { CodegenContext, FunctionMetadata } from "../context.js";
import type { HirFunction } from "../../semantics/hir/index.js";
import type { HirExprId, SymbolId, TypeId } from "../../semantics/ids.js";
import { abiTypeFor, getStructuralTypeInfo } from "../types.js";
import {
  canStoreScalarAggregateExpression,
  scalarAggregateAbiTypesForType,
} from "./scalar-aggregates.js";
import { walkHirExpression } from "../hir-walk.js";
import {
  composeSpecializationDimensions,
  functionSpecializationIdentity,
  tryAdmitFunctionSpecialization,
} from "../specialization-policy.js";

export interface ScalarAggregateCallSpecialization {
  base: FunctionMetadata;
  meta: FunctionMetadata;
  item: HirFunction;
  paramIndexes: readonly number[];
  scalarResult: boolean;
}

type ScalarAggregateCallSpecializationState = {
  byKey: Map<string, ScalarAggregateCallSpecialization>;
  pending: ScalarAggregateCallSpecialization[];
  compiled: Set<string>;
};

const SCALAR_AGGREGATE_CALL_SPECIALIZATION_STATE = Symbol(
  "voyd.codegen.scalarAggregateCallSpecializationState",
);

const stateOf = (ctx: CodegenContext): ScalarAggregateCallSpecializationState =>
  ctx.programHelpers.getHelperState<ScalarAggregateCallSpecializationState>(
    SCALAR_AGGREGATE_CALL_SPECIALIZATION_STATE,
    () => ({
      byKey: new Map(),
      pending: [],
      compiled: new Set(),
    }),
  );

const sanitize = (value: string): string =>
  value.replace(/[^a-zA-Z0-9_]/g, "_");

const functionItemFor = ({
  ctx,
  meta,
}: {
  ctx: CodegenContext;
  meta: FunctionMetadata;
}): HirFunction | undefined => {
  const targetCtx = ctx.moduleContexts.get(meta.moduleId);
  const targetModule =
    targetCtx?.module ?? ctx.program.modules.get(meta.moduleId);
  return Array.from(targetModule?.hir.items.values() ?? []).find(
    (item): item is HirFunction =>
      item.kind === "function" && item.symbol === meta.symbol,
  );
};

const assignmentTargetResolvesToSymbol = ({
  exprId,
  symbols,
  ctx,
}: {
  exprId: HirExprId;
  symbols: ReadonlySet<SymbolId>;
  ctx: CodegenContext;
}): boolean => {
  const expr = ctx.module.hir.expressions.get(exprId);
  if (!expr) {
    return false;
  }
  if (expr.exprKind === "identifier") {
    return symbols.has(expr.symbol);
  }
  if (expr.exprKind === "field-access") {
    return assignmentTargetResolvesToSymbol({
      exprId: expr.target,
      symbols,
      ctx,
    });
  }
  return false;
};

const aliasSymbolsForParameter = ({
  item,
  symbol,
  ctx,
}: {
  item: HirFunction;
  symbol: SymbolId;
  ctx: CodegenContext;
}): ReadonlySet<SymbolId> => {
  const adjacency = new Map<SymbolId, Set<SymbolId>>();
  const link = (left: SymbolId, right: SymbolId): void => {
    if (left === right) {
      return;
    }
    const leftAliases = adjacency.get(left) ?? new Set<SymbolId>();
    leftAliases.add(right);
    adjacency.set(left, leftAliases);
    const rightAliases = adjacency.get(right) ?? new Set<SymbolId>();
    rightAliases.add(left);
    adjacency.set(right, rightAliases);
  };
  const maybeLinkIdentifierAlias = ({
    targetSymbol,
    valueExprId,
  }: {
    targetSymbol: SymbolId;
    valueExprId: HirExprId;
  }): void => {
    const valueExpr = ctx.module.hir.expressions.get(valueExprId);
    if (valueExpr?.exprKind === "identifier") {
      link(targetSymbol, valueExpr.symbol);
    }
  };

  walkHirExpression({
    exprId: item.body,
    ctx,
    visitor: {
      onStmt: (_stmtId, stmt) => {
        if (stmt.kind === "let" && stmt.pattern.kind === "identifier") {
          maybeLinkIdentifierAlias({
            targetSymbol: stmt.pattern.symbol,
            valueExprId: stmt.initializer,
          });
        }
        return undefined;
      },
      onExpr: (_exprId, expr) => {
        if (expr.exprKind !== "assign") {
          return undefined;
        }
        if (typeof expr.target === "number") {
          const target = ctx.module.hir.expressions.get(expr.target);
          if (target?.exprKind === "identifier") {
            maybeLinkIdentifierAlias({
              targetSymbol: target.symbol,
              valueExprId: expr.value,
            });
          }
        }
        if (expr.pattern?.kind === "identifier") {
          maybeLinkIdentifierAlias({
            targetSymbol: expr.pattern.symbol,
            valueExprId: expr.value,
          });
        }
        return undefined;
      },
    },
  });

  const aliases = new Set<SymbolId>();
  const queue = [symbol];
  while (queue.length > 0) {
    const current = queue.pop()!;
    if (aliases.has(current)) {
      continue;
    }
    aliases.add(current);
    (adjacency.get(current) ?? new Set<SymbolId>()).forEach((next) => {
      queue.push(next);
    });
  }
  return aliases;
};

const parameterHasFieldAssignment = ({
  item,
  symbol,
  ctx,
}: {
  item: HirFunction;
  symbol: SymbolId;
  ctx: CodegenContext;
}): boolean => {
  const aliases = aliasSymbolsForParameter({ item, symbol, ctx });
  let hasAssignment = false;
  walkHirExpression({
    exprId: item.body,
    ctx,
    visitor: {
      onExpr: (_exprId, expr) => {
        if (
          expr.exprKind === "assign" &&
          typeof expr.target === "number" &&
          assignmentTargetResolvesToSymbol({
            exprId: expr.target,
            symbols: aliases,
            ctx,
          })
        ) {
          hasAssignment = true;
          return "stop";
        }
        return undefined;
      },
    },
  });
  return hasAssignment;
};

export const scalarAggregateParameterCanUseSpecializedAbi = ({
  meta,
  paramIndex,
  ctx,
}: {
  meta: FunctionMetadata;
  paramIndex: number;
  ctx: CodegenContext;
}): boolean => {
  if (meta.effectful) {
    return false;
  }
  const param = meta.parameters[paramIndex];
  if (!param || typeof param.symbol !== "number") {
    return false;
  }
  const structInfo = getStructuralTypeInfo(param.typeId, ctx);
  if (!structInfo || structInfo.layoutKind !== "heap-object") {
    return false;
  }
  const abiTypes = scalarAggregateAbiTypesForType({
    typeId: param.typeId,
    ctx,
  });
  if (!abiTypes || abiTypes.length === 0) {
    return false;
  }
  const item = functionItemFor({ ctx, meta });
  if (item?.parameters[paramIndex]?.mutable) {
    return false;
  }
  const targetCtx = ctx.moduleContexts.get(meta.moduleId) ?? ctx;
  if (
    item &&
    parameterHasFieldAssignment({
      item,
      symbol: param.symbol,
      ctx: targetCtx,
    })
  ) {
    return false;
  }
  const fact = ctx.optimization?.escapeAnalysis.parameters
    .get(meta.instanceId)
    ?.get(param.symbol);
  return Boolean(fact && !fact.escapes);
};

export const scalarAggregateResultCanUseSpecializedAbi = ({
  meta,
  resultTypeId,
  item,
  ctx,
}: {
  meta: FunctionMetadata;
  resultTypeId: TypeId;
  item?: HirFunction;
  ctx: CodegenContext;
}): boolean => {
  if (
    meta.effectful ||
    meta.resultAbiKind !== "direct" ||
    meta.resultTypeId !== resultTypeId
  ) {
    return false;
  }
  const structInfo = getStructuralTypeInfo(resultTypeId, ctx);
  if (!structInfo || structInfo.layoutKind !== "heap-object") {
    return false;
  }
  if (
    !item ||
    !heapObjectResultBodyIsFreshAggregate({
      exprId: item.body,
      resultTypeId,
      ctx,
    }) ||
    !canStoreScalarAggregateExpression({
      exprId: item.body,
      targetTypeId: resultTypeId,
      structInfo,
      ctx,
    })
  ) {
    return false;
  }
  const abiTypes = scalarAggregateAbiTypesForType({
    typeId: resultTypeId,
    ctx,
  });
  return Boolean(abiTypes && abiTypes.length > 0);
};

const heapObjectResultBodyIsFreshAggregate = ({
  exprId,
  resultTypeId,
  ctx,
}: {
  exprId: number;
  resultTypeId: TypeId;
  ctx: CodegenContext;
}): boolean => {
  const expr = ctx.module.hir.expressions.get(exprId);
  if (!expr) {
    return false;
  }
  if (expr.exprKind === "object-literal") {
    const structInfo = getStructuralTypeInfo(resultTypeId, ctx);
    return Boolean(
      structInfo &&
      canStoreScalarAggregateExpression({
        exprId,
        targetTypeId: resultTypeId,
        structInfo,
        ctx,
      }),
    );
  }
  if (expr.exprKind === "block") {
    return (
      expr.statements.length === 0 &&
      typeof expr.value === "number" &&
      heapObjectResultBodyIsFreshAggregate({
        exprId: expr.value,
        resultTypeId,
        ctx,
      })
    );
  }
  if (expr.exprKind === "if" || expr.exprKind === "cond") {
    return (
      typeof expr.defaultBranch === "number" &&
      expr.branches.every((branch) =>
        heapObjectResultBodyIsFreshAggregate({
          exprId: branch.value,
          resultTypeId,
          ctx,
        }),
      ) &&
      heapObjectResultBodyIsFreshAggregate({
        exprId: expr.defaultBranch,
        resultTypeId,
        ctx,
      })
    );
  }
  return false;
};

export const getOrCreateScalarAggregateCallSpecialization = ({
  ctx,
  meta,
  paramIndexes,
  scalarResultTypeId,
}: {
  ctx: CodegenContext;
  meta: FunctionMetadata;
  paramIndexes: ReadonlySet<number>;
  scalarResultTypeId?: TypeId;
}): FunctionMetadata | undefined => {
  const item = functionItemFor({ ctx, meta });
  const targetCtx = ctx.moduleContexts.get(meta.moduleId) ?? ctx;
  const scalarResult =
    typeof scalarResultTypeId === "number" &&
    scalarAggregateResultCanUseSpecializedAbi({
      meta,
      resultTypeId: scalarResultTypeId,
      item,
      ctx: targetCtx,
    });
  if (!ctx.optimization || (paramIndexes.size === 0 && !scalarResult)) {
    return undefined;
  }
  const selectedIndexes = Array.from(paramIndexes)
    .filter((paramIndex) =>
      scalarAggregateParameterCanUseSpecializedAbi({ meta, paramIndex, ctx }),
    )
    .sort((left, right) => left - right);
  if (selectedIndexes.length === 0 && !scalarResult) {
    return undefined;
  }
  if (!item) {
    return undefined;
  }

  const specializationDimensions = composeSpecializationDimensions({
    meta,
    next: {
      scalarAggregate: {
        parameterIndexes: selectedIndexes,
        result: scalarResult,
      },
    },
  });
  const key = functionSpecializationIdentity({
    meta,
    dimensions: specializationDimensions,
  });
  const state = stateOf(ctx);
  const existing = state.byKey.get(key);
  if (existing) {
    return existing.meta;
  }
  const existingForFunction = Array.from(state.byKey.values()).filter(
    (specialization) =>
      specialization.base.moduleId === meta.moduleId &&
      specialization.base.instanceId === meta.instanceId,
  );
  if (
    !tryAdmitFunctionSpecialization({
      ctx,
      meta,
      item,
      kind: "scalar_aggregate",
      dimensions: specializationDimensions,
      existingKindVariants: existingForFunction.length,
      maxKindVariants:
        ctx.specializationPolicy.scalarAggregateCallContextsPerFunction,
    })
  ) {
    return undefined;
  }

  const paramAbiTypes = meta.paramAbiTypes.map((abiTypes, index) =>
    selectedIndexes.includes(index) &&
    typeof meta.paramTypeIds[index] === "number"
      ? (scalarAggregateAbiTypesForType({
          typeId: meta.paramTypeIds[index]!,
          ctx,
        }) ?? abiTypes)
      : abiTypes,
  );
  const userParamTypes = paramAbiTypes.flat();
  const widened = ctx.effectsBackend.abi.widenSignature({
    ctx,
    effectful: meta.effectful,
    userParamTypes: meta.outParamType
      ? [meta.outParamType, ...userParamTypes]
      : userParamTypes,
    userResultType: scalarResult
      ? abiTypeFor(
          scalarAggregateAbiTypesForType({
            typeId: meta.resultTypeId,
            ctx,
          }) ?? [meta.resultType],
        )
      : meta.resultAbiKind === "out_ref"
        ? binaryen.none
        : meta.resultType,
  });
  const resultAbiTypes = scalarResult
    ? (scalarAggregateAbiTypesForType({ typeId: meta.resultTypeId, ctx }) ??
      meta.resultAbiTypes)
    : meta.resultAbiTypes;
  const specializedMeta: FunctionMetadata = {
    ...meta,
    wasmName: `${meta.wasmName}__scalar_agg_${sanitize(
      `${selectedIndexes.join("_")}${scalarResult ? "_result" : ""}`,
    )}`,
    paramTypes: widened.paramTypes,
    paramAbiTypes,
    userParamOffset: widened.userParamOffset,
    firstUserParamIndex: widened.userParamOffset + (meta.outParamType ? 1 : 0),
    resultType: widened.resultType,
    resultAbiTypes,
    scalarAggregateParamIndexes: selectedIndexes,
    scalarAggregateResult: scalarResult,
    specialization: specializationDimensions,
  };
  const specialization: ScalarAggregateCallSpecialization = {
    base: meta,
    meta: specializedMeta,
    item,
    paramIndexes: selectedIndexes,
    scalarResult,
  };
  state.byKey.set(key, specialization);
  state.pending.push(specialization);
  return specializedMeta;
};

export const takePendingScalarAggregateCallSpecializations = (
  ctx: CodegenContext,
): ScalarAggregateCallSpecialization[] => {
  const state = stateOf(ctx);
  const pending = state.pending.filter(
    (specialization) =>
      specialization.meta.moduleId === ctx.moduleId &&
      !state.compiled.has(specialization.meta.wasmName),
  );
  state.pending = state.pending.filter(
    (specialization) =>
      specialization.meta.moduleId !== ctx.moduleId &&
      !state.compiled.has(specialization.meta.wasmName),
  );
  return pending;
};

export const markScalarAggregateCallSpecializationCompiled = ({
  ctx,
  wasmName,
}: {
  ctx: CodegenContext;
  wasmName: string;
}): void => {
  stateOf(ctx).compiled.add(wasmName);
};
