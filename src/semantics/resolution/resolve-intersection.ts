import { IntersectionType } from "../../syntax-objects/types.js";
import { getExprType } from "./get-expr-type.js";
import { resolveEntities } from "./resolve-entities.js";

export const resolveIntersectionType = (
  inter: IntersectionType
): IntersectionType => {
  inter.nominalTypeExpr.value = resolveEntities(inter.nominalTypeExpr.value);
  inter.structuralTypeExpr.value = resolveEntities(
    inter.structuralTypeExpr.value
  );

  const nominalType = getExprType(inter.nominalTypeExpr.value);
  const structuralType = getExprType(inter.structuralTypeExpr.value);

  // TODO Error if not correct type
  inter.nominalType = nominalType?.isObjectType() ? nominalType : undefined;
  inter.structuralType = structuralType?.isObjectType()
    ? structuralType
    : undefined;

  return inter;
};
