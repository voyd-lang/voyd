import { UnionType, voydString } from "../../syntax-objects/types.js";
import { getExprType } from "./get-expr-type.js";
import { resolveEntities } from "./resolve-entities.js";
import { resolveTypeExpr } from "./resolve-type-expr.js";

export const resolveUnionType = (union: UnionType): UnionType => {
  if (union.hasAttribute("type-resolution-started")) return union;
  union.setAttribute("type-resolution-started", true);
  union.childTypeExprs.applyMap((expr) => resolveEntities(expr));
  union.types = union.childTypeExprs.toArray().flatMap((expr) => {
    const type = getExprType(resolveTypeExpr(expr));

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
