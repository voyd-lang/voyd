import binaryen from "binaryen";
import type {
  CodegenContext,
  CompiledExpression,
  ExpressionCompiler,
  FunctionContext,
  HirAssignExpr,
} from "../context.js";
import { compilePatternInitialization } from "../patterns.js";
import {
  coerceValueToType,
  storeStructuralField,
} from "../structural.js";
import { allocateTempLocal, getRequiredBinding } from "../locals.js";
import {
  getRequiredExprType,
  getStructuralTypeInfo,
  getSymbolTypeId,
} from "../types.js";
import { refCast, structSetFieldValue } from "@voyd/lib/binaryen-gc/index.js";

export const compileAssignExpr = (
  expr: HirAssignExpr,
  ctx: CodegenContext,
  fnCtx: FunctionContext,
  compileExpr: ExpressionCompiler
): CompiledExpression => {
  const typeInstanceKey = fnCtx.typeInstanceKey ?? fnCtx.instanceKey;
  if (expr.pattern) {
    const ops: binaryen.ExpressionRef[] = [];
    compilePatternInitialization({
      pattern: expr.pattern,
      initializer: expr.value,
      ctx,
      fnCtx,
      ops,
      compileExpr,
      options: { declare: false },
    });
    const opExpr =
      ops.length === 1 ? ops[0]! : ctx.mod.block(null, ops, binaryen.none);
    return { expr: opExpr, usedReturnCall: false };
  }

  if (typeof expr.target !== "number") {
    throw new Error("assignment missing target expression");
  }

  const targetExpr = ctx.module.hir.expressions.get(expr.target);
  if (!targetExpr) {
    throw new Error("assignment missing target expression");
  }

  const valueTypeId = getRequiredExprType(expr.value, ctx, typeInstanceKey);
  const valueExpr = compileExpr({ exprId: expr.value, ctx, fnCtx });

  if (targetExpr.exprKind === "field-access") {
    const structTypeId = getRequiredExprType(
      targetExpr.target,
      ctx,
      typeInstanceKey
    );
    const structInfo = getStructuralTypeInfo(structTypeId, ctx);
    if (!structInfo) {
      throw new Error("field assignment requires a structural object");
    }
    const field = structInfo.fieldMap.get(targetExpr.field);
    if (!field) {
      throw new Error(`object does not contain field ${targetExpr.field}`);
    }
    const targetTypeId = getRequiredExprType(
      expr.target,
      ctx,
      typeInstanceKey
    );
    const coerced = coerceValueToType({
      value: valueExpr.expr,
      actualType: valueTypeId,
      targetType: targetTypeId,
      ctx,
      fnCtx,
    });
    const pointerTemp = allocateTempLocal(structInfo.interfaceType, fnCtx);
    const pointerStore = ctx.mod.local.set(
      pointerTemp.index,
      compileExpr({ exprId: targetExpr.target, ctx, fnCtx }).expr
    );
    const pointer = ctx.mod.local.get(
      pointerTemp.index,
      structInfo.interfaceType
    );
    const store = storeStructuralField({
      structInfo,
      field,
      pointer,
      value: coerced,
      ctx,
    });
    return {
      expr: ctx.mod.block(null, [pointerStore, store], binaryen.none),
      usedReturnCall: false,
    };
  }

  if (targetExpr.exprKind !== "identifier") {
    throw new Error("only identifier assignments are supported today");
  }

  const binding = getRequiredBinding(targetExpr.symbol, ctx, fnCtx);
  const targetTypeId = getSymbolTypeId(targetExpr.symbol, ctx);
  const coerced = coerceValueToType({
    value: valueExpr.expr,
    actualType: valueTypeId,
    targetType: targetTypeId,
    ctx,
    fnCtx,
  });

  if (binding.kind === "capture") {
    if (!binding.mutable) {
      throw new Error("cannot assign to immutable capture");
    }
    const envRef = ctx.mod.local.get(binding.envIndex, binding.envSuperType);
    const typedEnv =
      binding.envType === binding.envSuperType
        ? envRef
        : refCast(ctx.mod, envRef, binding.envType);
    return {
      expr: structSetFieldValue({
        mod: ctx.mod,
        fieldIndex: binding.fieldIndex,
        ref: typedEnv,
        value: coerced,
      }),
      usedReturnCall: false,
    };
  }

  return {
    expr: ctx.mod.local.set(binding.index, coerced),
    usedReturnCall: false,
  };
};
