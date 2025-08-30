import { UnionType } from "../../syntax-objects/types.js";
import { getExprType } from "./get-expr-type.js";
import { resolveTypeExpr } from "./resolve-type-expr.js";

export const resolveUnionType = (union: UnionType): UnionType => {
  if (union.childTypeExprs.length === 0) return union;
  union.types = union.childTypeExprs.toArray().flatMap((expr) => {
    const resolved = resolveTypeExpr(expr);
    const type = getExprType(resolved);
    if (!type) {
      // Fallback: if a child identifier hasn't produced a Type yet (e.g., due to
      // ordering during canonicalized resolution), include the resolved entity
      // directly when it is a Type to avoid dropping legitimate union members.
      if ((resolved as any).isIdentifier?.()) {
        const ent = (resolved as any).resolve?.();
        if (ent?.isType?.()) return [ent as any];
      }
      return [];
    }
    return type.isUnionType() ? type.types : type.isRefType() ? [type] : [];
  });
  return union;
};
