import { Expr } from "../../syntax-objects/expr.js";
import { Identifier } from "../../syntax-objects/identifier.js";
import { List } from "../../syntax-objects/list.js";
import { Type } from "../../syntax-objects/types.js";
import { getExprType } from "./get-expr-type.js";

export type TypeArgInferencePair = {
  typeExpr: Expr;
  argExpr: Expr;
};

export const inferTypeArgs = (
  typeParams: Identifier[] | undefined,
  pairs: TypeArgInferencePair[]
): List | undefined => {
  if (!typeParams?.length) return;

  const inferred: Type[] = [];

  for (const tp of typeParams) {
    let inferredType: Type | undefined;

    for (const { typeExpr, argExpr } of pairs) {
      if (typeExpr.isIdentifier() && typeExpr.is(tp)) {
        inferredType = getExprType(argExpr);
        break;
      }
    }

    if (!inferredType) return undefined;

    inferred.push(inferredType);
  }

  return new List({ value: inferred });
};
