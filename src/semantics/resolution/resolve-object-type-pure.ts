import { ObjectType, voydBaseObject } from "../../syntax-objects/types.js";
import { getExprType } from "./get-expr-type.js";
import { resolveTypeExpr } from "./resolve-type-expr.js";

/**
 * Resolve an object type. When `clone` is true (default), the object is cloned
 * prior to resolution to preserve the original instance.
 */
export const resolveObjectTypePure = (
  obj: ObjectType,
  clone = true
): ObjectType => {
  const newObj = clone ? obj.clone() : obj;

  newObj.fields.forEach((field) => {
    field.typeExpr = resolveTypeExpr(field.typeExpr);
    field.type = field.type ?? getExprType(field.typeExpr);
  });

  if (newObj.parentObjExpr) {
    newObj.parentObjExpr = resolveTypeExpr(newObj.parentObjExpr);
    const parentType = getExprType(newObj.parentObjExpr);
    newObj.parentObjType = parentType?.isObjectType() ? parentType : undefined;
  } else {
    newObj.parentObjType = voydBaseObject;
  }

  if (newObj.appliedTypeArgs) {
    newObj.appliedTypeArgs.forEach((alias) => {
      const aliasType = getExprType(alias);
      newObj.fields.forEach((field) => {
        if (field.typeExpr.isIdentifier() && field.typeExpr.is(alias.name)) {
          field.type = aliasType;
        }
      });
    });
  }

  newObj.typesResolved = true;
  return newObj;
};
