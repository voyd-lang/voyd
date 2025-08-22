import { UnionType, voydString } from "../../syntax-objects/types.js";
import { getExprType } from "./get-expr-type.js";
import { resolveEntities } from "./resolve-entities.js";
import { resolveTypeExpr } from "./resolve-type-expr.js";

export const resolveUnionType = (union: UnionType): UnionType => {
  if (union.resolutionPhase > 0) return union;
  union.resolutionPhase = 1;
  union.types = union.childTypeExprs.toArray().flatMap((expr) => {
    const resolved = resolveTypeExpr(expr);
    const type = getExprType(resolved);

    // TODO: Better string object check
    if (!type?.isObjectType() && !(type === voydString)) {
      console.log(expr);
      console.log(type);
      console.warn(`Union type must be an object type at ${expr.location}`);
    }

    return type?.isObjectType() ? [type] : [];
  });
  return union;
};
