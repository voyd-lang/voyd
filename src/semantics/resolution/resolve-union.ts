import { UnionType } from "../../syntax-objects/types.js";
import { getExprType } from "./get-expr-type.js";
import { resolveTypeExpr } from "./resolve-type-expr.js";

export const resolveUnionType = (union: UnionType): UnionType => {
  if (union.resolutionPhase > 0) return union;
  union.resolutionPhase = 1;
  union.types = union.childTypeExprs.toArray().flatMap((expr) => {
    const resolved = resolveTypeExpr(expr);
    const type = getExprType(resolved);
    return type?.isObjectType() ? [type] : [];
  });
  return union;
};
