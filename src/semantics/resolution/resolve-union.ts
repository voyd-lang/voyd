import { UnionType } from "../../syntax-objects/types.js";
import { getExprType } from "./get-expr-type.js";
import { resolveTypes } from "./resolve-types.js";

export const resolveUnionType = (union: UnionType): UnionType => {
  union.childTypeExprs.applyMap((expr) => resolveTypes(expr));
  union.types = union.childTypeExprs.toArray().flatMap((expr) => {
    const type = getExprType(expr);

    if (!type?.isObjectType()) {
      console.warn(`Union type must be an object type at ${expr.location}`);
    }

    return type?.isObjectType() ? [type] : [];
  });

  return union;
};
