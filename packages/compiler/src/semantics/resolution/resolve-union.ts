import { UnionType } from "../../syntax-objects/types.js";
import { getExprType } from "./get-expr-type.js";
import { resolveTypeExpr } from "./resolve-type-expr.js";

export const resolveUnionType = (union: UnionType): UnionType => {
  if (union.resolutionPhase > 0 || union.memberTypeExprs.length === 0)
    return union;
  union.resolutionPhase = 1;
  union.resolvedMemberTypes = union.memberTypeExprs
    .toArray()
    .flatMap((expr) => {
      const resolved = resolveTypeExpr(expr);
      const type = getExprType(resolved);
      if (!type) return [];
      return type.isUnionType()
        ? type.resolvedMemberTypes
        : type.isRefType()
        ? [type]
        : [];
    });
  return union;
};
