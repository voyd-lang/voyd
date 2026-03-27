import binaryen from "binaryen";
import type { CodegenContext, FunctionContext } from "../context.js";

export const asStatement = (
  ctx: CodegenContext,
  expr: binaryen.ExpressionRef,
  fnCtx?: FunctionContext,
): binaryen.ExpressionRef => {
  const type = binaryen.getExpressionType(expr);
  if (type === binaryen.none || type === binaryen.unreachable) {
    return expr;
  }
  const abiTypes = [...binaryen.expandType(type)];
  if (abiTypes.length > 1) {
    if (!fnCtx) {
      throw new Error("multivalue statements require a function context");
    }
    const tupleLocal = fnCtx.nextLocalIndex;
    fnCtx.nextLocalIndex += 1;
    fnCtx.locals.push(type);
    return ctx.mod.local.set(tupleLocal, expr);
  }
  return ctx.mod.drop(expr);
};

export const coerceToBinaryenType = (
  ctx: CodegenContext,
  expr: binaryen.ExpressionRef,
  type: binaryen.Type,
  fnCtx?: FunctionContext,
): binaryen.ExpressionRef => {
  const exprType = binaryen.getExpressionType(expr);
  if (type === binaryen.none) {
    return asStatement(ctx, expr, fnCtx);
  }
  if (exprType === type || exprType === binaryen.unreachable) {
    return expr;
  }
  if (exprType === binaryen.none) {
    return ctx.mod.block(null, [expr, ctx.mod.unreachable()], type);
  }
  return ctx.mod.block(null, [expr], type);
};
