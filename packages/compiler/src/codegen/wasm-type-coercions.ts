import binaryen from "binaryen";
import { refCast } from "@voyd/lib/binaryen-gc/index.js";
import type { CodegenContext } from "./context.js";

const NON_REF_TYPES = new Set<number>([
  binaryen.none,
  binaryen.unreachable,
  binaryen.i32,
  binaryen.i64,
  binaryen.f32,
  binaryen.f64,
]);

const isRefType = (type: binaryen.Type): boolean => !NON_REF_TYPES.has(type);

export const coerceExprToWasmType = ({
  expr,
  targetType,
  ctx,
}: {
  expr: binaryen.ExpressionRef;
  targetType: binaryen.Type;
  ctx: CodegenContext;
}): binaryen.ExpressionRef => {
  const exprType = binaryen.getExpressionType(expr);
  if (exprType === targetType) {
    return expr;
  }
  if (targetType === ctx.rtt.baseType) {
    return expr;
  }
  if (!isRefType(exprType) || !isRefType(targetType)) {
    return expr;
  }
  const shouldCast =
    exprType === ctx.rtt.baseType ||
    exprType === binaryen.anyref ||
    exprType === binaryen.eqref;
  if (!shouldCast) {
    return expr;
  }
  return refCast(ctx.mod, expr, targetType);
};
