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
): binaryen.ExpressionRef =>
  type === binaryen.none
    ? asStatement(ctx, expr)
    : binaryen.getExpressionType(expr) === type
      ? expr
      : ctx.mod.block(null, [expr], type);
