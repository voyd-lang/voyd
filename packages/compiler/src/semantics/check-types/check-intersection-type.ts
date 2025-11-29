import { IntersectionType } from "../../syntax-objects/types.js";
import { checkTypeExpr } from "./check-type-expr.js";

export const checkIntersectionType = (inter: IntersectionType) => {
  checkTypeExpr(inter.nominalTypeExpr.value);
  checkTypeExpr(inter.structuralTypeExpr.value);

  if (!inter.nominalType || !inter.structuralType) {
    throw new Error(`Unable to resolve intersection type ${inter.location}`);
  }

  if (!inter.structuralType.isStructural) {
    throw new Error(
      `Structural type must be a structural type ${inter.structuralTypeExpr.value.location}`
    );
  }

  return inter;
};

