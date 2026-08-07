import type {
  CodegenContext,
  FunctionMetadata,
  StructuralTypeInfo,
} from "../context.js";
import type { HirFunction } from "../../semantics/hir/index.js";
import type { HirExprId, SymbolId } from "../../semantics/ids.js";
import { getOptimizedResultAbiKind, getStructuralTypeInfo } from "../types.js";
import { walkHirExpression } from "../hir-walk.js";
import {
  composeSpecializationDimensions,
  tryAdmitFunctionSpecialization,
  type FunctionSpecializationDimensions,
} from "../specialization-policy.js";

export const mutableScalarAggregateCalleeCanUseLaneAbi = ({
  meta,
  paramIndex,
  ctx,
}: {
  meta: FunctionMetadata;
  paramIndex: number;
  ctx: CodegenContext;
}): boolean => {
  const typeId = meta.paramTypeIds[paramIndex];
  const item = functionItemFor({ ctx, meta });
  const signature = ctx.program.functions.getSignature(
    meta.moduleId,
    meta.symbol,
  );
  const parameter = signature?.parameters[paramIndex];
  const hirParameter = item?.parameters[paramIndex];
  const targetCtx = ctx.moduleContexts.get(meta.moduleId);
  const structInfo =
    typeof typeId === "number" && targetCtx
      ? getStructuralTypeInfo(typeId, targetCtx)
      : undefined;
  const functionId = ctx.program.functions.getFunctionId({
    moduleId: meta.moduleId,
    symbol: meta.symbol,
  });
  const footprint =
    typeof functionId === "number"
      ? ctx.program.callableAccesses.getFootprint(functionId)
      : undefined;
  const access = footprint?.parameters[paramIndex];

  if (
    !item ||
    !targetCtx ||
    !structInfo ||
    structInfo.layoutKind !== "heap-object" ||
    !hirParameter ||
    typeof hirParameter.symbol !== "number" ||
    !signature ||
    !ctx.program.effects.isEmpty(signature.effectRow) ||
    meta.resultTypeId !== signature.returnType ||
    meta.resultAbiKind !== "direct" ||
    getOptimizedResultAbiKind({ typeId: meta.resultTypeId, ctx: targetCtx }) !==
      "direct" ||
    meta.effectful ||
    meta.paramAbiKinds[paramIndex] !== "mutable_ref" ||
    parameter?.bindingKind !== "mutable-ref" ||
    parameter.optional ||
    parameter.defaulted ||
    parameter.typeId !== typeId ||
    !footprint ||
    !access ||
    footprint.maySuspend ||
    footprint.externalRead ||
    footprint.externalWrite ||
    access.runtimeCheckedWrites ||
    access.retained ||
    access.returned ||
    access.returnedProvenance ||
    access.writePaths.length === 0 ||
    !parameterUsesOnlyDirectFields({
      item,
      symbol: hirParameter.symbol,
      allowReturns: meta.resultTypeId !== ctx.program.primitives.void,
      ctx: targetCtx,
    })
  ) {
    return false;
  }

  return (
    access.readPaths.every((path) => directFieldPath(path, structInfo)) &&
    access.writePaths.every((path) => directFieldPath(path, structInfo))
  );
};

export const mutableScalarAggregateSpecializationDimensions = ({
  meta,
  paramIndex,
}: {
  meta: FunctionMetadata;
  paramIndex: number;
}): FunctionSpecializationDimensions =>
  composeSpecializationDimensions({
    meta,
    next: {
      scalarAggregate: {
        parameterIndexes: [paramIndex],
        result: false,
      },
    },
  });

export const tryReserveMutableScalarAggregateSpecialization = ({
  meta,
  paramIndex,
  existingKindVariants,
  ctx,
}: {
  meta: FunctionMetadata;
  paramIndex: number;
  existingKindVariants: number;
  ctx: CodegenContext;
}): boolean => {
  const item = functionItemFor({ ctx, meta });
  if (!item) {
    return false;
  }
  return tryAdmitFunctionSpecialization({
    ctx,
    meta,
    item,
    kind: "scalar_aggregate",
    dimensions: mutableScalarAggregateSpecializationDimensions({
      meta,
      paramIndex,
    }),
    existingKindVariants,
    maxKindVariants:
      ctx.specializationPolicy.scalarAggregateCallContextsPerFunction,
  });
};

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

const parameterUsesOnlyDirectFields = ({
  item,
  symbol,
  allowReturns,
  ctx,
}: {
  item: HirFunction;
  symbol: SymbolId;
  allowReturns: boolean;
  ctx: CodegenContext;
}): boolean => {
  const allowedIdentifiers = new Set<HirExprId>();
  let safe = true;
  walkHirExpression({
    exprId: item.body,
    ctx,
    visitor: {
      onStmt: (_stmtId, stmt) => {
        if (stmt.kind === "return" && !allowReturns) {
          safe = false;
          return "stop";
        }
        return undefined;
      },
      onExpr: (exprId, expr) => {
        if (expr.exprKind === "field-access") {
          const target = ctx.module.hir.expressions.get(expr.target);
          if (target?.exprKind === "identifier" && target.symbol === symbol) {
            allowedIdentifiers.add(target.id);
          }
          return undefined;
        }
        if (
          expr.exprKind === "identifier" &&
          expr.symbol === symbol &&
          !allowedIdentifiers.has(exprId)
        ) {
          safe = false;
          return "stop";
        }
        return undefined;
      },
    },
  });
  return safe;
};

const directFieldPath = (
  path: readonly import("../../semantics/codegen-view/index.js").CodegenPlaceProjection[],
  structInfo: StructuralTypeInfo,
): boolean =>
  path.length === 1 &&
  path[0]?.kind === "field" &&
  structInfo.fieldMap.has(path[0].name);
