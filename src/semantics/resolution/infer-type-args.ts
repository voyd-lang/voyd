import { Expr } from "../../syntax-objects/expr.js";
import { Identifier } from "../../syntax-objects/identifier.js";
import { nop } from "../../syntax-objects/index.js";
import { List } from "../../syntax-objects/list.js";
import { Type, TypeAlias } from "../../syntax-objects/types.js";
import { getExprType } from "./get-expr-type.js";
import { resolveTypeExpr } from "./resolve-type-expr.js";

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
        inferredType = new TypeAlias({
          name: typeExpr.clone(),
          typeExpr: nop(),
        });
        resolveTypeExpr(argExpr);
        inferredType.type = getExprType(argExpr);
        break;
      }
    }

    if (!inferredType) return undefined;

    inferred.push(inferredType);
  }

  return new List({ value: inferred });
};
