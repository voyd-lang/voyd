import binaryen from "binaryen";
import type {
  CodegenContext,
  CompiledExpression,
  ExpressionCompiler,
  FunctionContext,
  HirFieldAccessExpr,
} from "../context.js";
import {
  allocateTempLocal,
  loadLocalValue,
  storeLocalValue,
} from "../locals.js";
import { coerceValueToType } from "../structural.js";
import {
  getRequiredExprType,
  getStructuralTypeInfo,
} from "../types.js";
import { coerceExprToWasmType } from "../wasm-type-coercions.js";
import { asStatement } from "../expressions/utils.js";
import { compileCallArgExpressionsWithTemps } from "../expressions/call/shared.js";

export const tryCompileSemanticCopyForwardedFieldAccess = ({
  expr,
  expectedFieldTypeId,
  expectedFieldWasmType,
  ctx,
  fnCtx,
  compileExpr,
}: {
  expr: HirFieldAccessExpr;
  expectedFieldTypeId: number;
  expectedFieldWasmType: binaryen.Type;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  compileExpr: ExpressionCompiler;
}): CompiledExpression | undefined => {
  if (
    !ctx.optimization?.semanticCopyForwardingFieldAccesses
      .get(ctx.moduleId)
      ?.has(expr.id)
  ) {
    return undefined;
  }

  const targetExpr = ctx.module.hir.expressions.get(expr.target);
  if (
    targetExpr?.exprKind !== "object-literal" ||
    targetExpr.entries.some((entry) => entry.kind !== "field")
  ) {
    return undefined;
  }

  const typeInstanceId = fnCtx.typeInstanceId ?? fnCtx.instanceId;
  const targetTypeId = getRequiredExprType(expr.target, ctx, typeInstanceId);
  const structInfo = getStructuralTypeInfo(targetTypeId, ctx);
  const selectedIndex = targetExpr.entries.findIndex(
    (entry) => entry.kind === "field" && entry.name === expr.field,
  );
  const selectedField = structInfo?.fieldMap.get(expr.field);
  if (!structInfo || selectedIndex < 0 || !selectedField) {
    return undefined;
  }

  const entryValues = compileCallArgExpressionsWithTemps({
    callId: targetExpr.id,
    args: targetExpr.entries.map((entry) => ({ expr: entry.value })),
    expectedTypeIdAt: (index) => {
      const entry = targetExpr.entries[index];
      return entry?.kind === "field"
        ? structInfo.fieldMap.get(entry.name)?.typeId
        : undefined;
    },
    ctx,
    fnCtx,
    compileExpr,
  });
  const selectedTemp = allocateTempLocal(
    expectedFieldWasmType,
    fnCtx,
    expectedFieldTypeId,
    ctx,
  );

  const ops = targetExpr.entries.map((entry, index) => {
    if (entry.kind !== "field") {
      throw new Error("copy-forwarded object literal unexpectedly contains a spread");
    }

    const field = structInfo.fieldMap.get(entry.name);
    const actualTypeId = getRequiredExprType(entry.value, ctx, typeInstanceId);
    const value = coerceValueToType({
      value: entryValues[index]!,
      actualType: field?.typeId ?? actualTypeId,
      targetType: field?.typeId,
      ctx,
      fnCtx,
    });

    if (index !== selectedIndex) {
      return asStatement(ctx, value, fnCtx);
    }

    const selectedValue = coerceValueToType({
      value,
      actualType: selectedField.typeId,
      targetType: expectedFieldTypeId,
      ctx,
      fnCtx,
    });
    return storeLocalValue({
      binding: selectedTemp,
      value: coerceExprToWasmType({
        expr: selectedValue,
        targetType: expectedFieldWasmType,
        ctx,
      }),
      ctx,
      fnCtx,
    });
  });

  return {
    expr: ctx.mod.block(
      null,
      [...ops, loadLocalValue(selectedTemp, ctx)],
      expectedFieldWasmType,
    ),
    usedReturnCall: false,
  };
};
