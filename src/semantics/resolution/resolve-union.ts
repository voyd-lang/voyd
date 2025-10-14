import { UnionType } from "../../syntax-objects/types.js";
import { internTypeWithContext } from "../types/type-context.js";
import { getExprType } from "./get-expr-type.js";
import { resolveTypeExpr } from "./resolve-type-expr.js";

export const resolveUnionType = (union: UnionType): UnionType => {
  if (union.resolutionPhase > 0 || union.childTypeExprs.length === 0)
    return internTypeWithContext(union) as UnionType;
  union.resolutionPhase = 1;
  union.types = union.childTypeExprs.toArray().flatMap((expr) => {
    const resolved = resolveTypeExpr(expr);
    const type = getExprType(resolved);
    if (!type) return [];
    return type.isUnionType() ? type.types : type.isRefType() ? [type] : [];
  });
  return internTypeWithContext(union) as UnionType;
};
