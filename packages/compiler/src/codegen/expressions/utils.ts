import binaryen from "binaryen";
import type { CodegenContext } from "../context.js";

export const asStatement = (
  ctx: CodegenContext,
  expr: binaryen.ExpressionRef
): binaryen.ExpressionRef => {
  const type = binaryen.getExpressionType(expr);
  if (type === binaryen.none || type === binaryen.unreachable) {
    return expr;
  }
  return ctx.mod.drop(expr);
};

export const coerceToBinaryenType = (
  ctx: CodegenContext,
  expr: binaryen.ExpressionRef,
  type: binaryen.Type
): binaryen.ExpressionRef => {
  const exprType = binaryen.getExpressionType(expr);
  if (type === binaryen.none) {
    return asStatement(ctx, expr);
  }
  if (exprType === type || exprType === binaryen.unreachable) {
    return expr;
  }
  if (exprType === binaryen.none) {
    return ctx.mod.block(null, [expr, ctx.mod.unreachable()], type);
  }
  return ctx.mod.block(null, [expr], type);
};
