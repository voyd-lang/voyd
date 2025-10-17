import { UnionType, Type } from "../../syntax-objects/types.js";
import { checkTypeExpr } from "./check-type-expr.js";

export const checkUnionType = (union: UnionType) => {
  union.memberTypeExprs.each(checkTypeExpr);

  if (union.resolvedMemberTypes.length !== union.memberTypeExprs.length) {
    throw new Error(`Unable to resolve every type in union ${union.location}`);
  }

  union.resolvedMemberTypes.forEach((t: Type) => {
    const isObjectType =
      t.isObjectType() || t.isIntersectionType() || t.isUnionType();
    if (!isObjectType) {
      throw new Error(
        `Union must be made up of object types ${union.location}`
      );
    }
  });

  return union;
};
