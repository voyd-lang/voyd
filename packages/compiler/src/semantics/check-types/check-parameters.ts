import { Parameter } from "../../syntax-objects/parameter.js";
import { checkTypeExpr } from "./check-type-expr.js";

export const checkParameters = (params: Parameter[]) => {
  params.forEach((p) => {
    if (!p.type) {
      throw new Error(
        `Unable to determine type for ${p} at ${p.name.location}`
      );
    }

    checkTypeExpr(p.typeExpr);
  });
};

