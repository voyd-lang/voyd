import { UnionType } from "../../syntax-objects/types.js";
import { getExprType } from "./get-expr-type.js";
import { resolveEntities } from "./resolve-entities.js";

export const resolveUnionType = (union: UnionType): UnionType => {
  union.childTypeExprs.applyMap((expr) => resolveEntities(expr));
  union.types = union.childTypeExprs.toArray().flatMap((expr) => {
    const type = getExprType(expr);

    if (!type?.isObjectType()) {
      console.warn(`Union type must be an object type at ${expr.location}`);
    }

    return type?.isObjectType() ? [type] : [];
  });

  return union;
};
