import { IntersectionType } from "../../syntax-objects/types.js";
import { internTypeWithContext } from "../types/type-context.js";
import { getExprType } from "./get-expr-type.js";
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

  inter.nominalType = nominalType?.isObjectType() ? nominalType : undefined;
  inter.structuralType = structuralType?.isObjectType()
    ? structuralType
    : undefined;

  return internTypeWithContext(inter) as IntersectionType;
};
