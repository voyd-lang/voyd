import { IntersectionType } from "../../syntax-objects/types.js";
import { getExprType } from "./get-expr-type.js";
import { resolveEntities } from "./resolve-entities.js";
import { resolveTypeExpr } from "./resolve-type-expr.js";

export const resolveIntersectionType = (
  inter: IntersectionType
): IntersectionType => {
  inter.nominalTypeExpr.value = resolveTypeExpr(inter.nominalTypeExpr.value);
  inter.structuralTypeExpr.value = resolveTypeExpr(
    inter.structuralTypeExpr.value
  );

  const nominalType = getExprType(inter.nominalTypeExpr.value);
  const structuralType = getExprType(inter.structuralTypeExpr.value);

  // TODO Error if not correct type
  inter.nominalType = nominalType?.isObj() ? nominalType : undefined;
  inter.structuralType = structuralType?.isObj() ? structuralType : undefined;

  return inter;
};
