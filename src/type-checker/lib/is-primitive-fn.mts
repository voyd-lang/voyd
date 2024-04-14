import { Expr } from "../../syntax-objects/expr.mjs";

export const isPrimitiveFn = (expr?: Expr) => {
  if (!expr?.isIdentifier()) return false;
  return new Set(["if", "=", "struct", "quote", "labeled-expr"]).has(
    expr.value
  );
};
