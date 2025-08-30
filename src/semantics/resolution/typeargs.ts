import { Expr, List } from "../../syntax-objects/index.js";
import { canonicalTypeExprFromType } from "./canonical-type-expr.js";
import { getExprType } from "./get-expr-type.js";

// Convert any expr into a lightweight type-argument expression:
// - If given a Type, return a canonical type-expr for that type.
// - If given a value-level expr (e.g., ObjectLiteral), derive its type and
//   return a canonical type-expr for that type.
// - Otherwise, return the expression unchanged (identifiers, calls, aliases).
export const lightweightTypeArgExpr = (e: Expr | undefined): Expr | undefined => {
  if (!e) return undefined;
  if (e.isType && e.isType()) {
    // Preserve unions to avoid altering member resolution order/identity
    if ((e as any).isUnionType?.() && (e as any).isUnionType()) return e as Expr;
    return (canonicalTypeExprFromType(e as any) ?? (e as any)) as Expr;
  }
  if (e.isObjectLiteral?.() || e.isArrayLiteral?.() || e.isBlock?.() || e.isFn?.()) {
    const t = getExprType(e);
    return (canonicalTypeExprFromType(t) ?? e) as Expr;
  }
  return e;
};

export const sanitizeTypeArgs = (list?: List): List | undefined => {
  if (!list) return undefined;
  return list.map((e) => lightweightTypeArgExpr(e) ?? e);
};
