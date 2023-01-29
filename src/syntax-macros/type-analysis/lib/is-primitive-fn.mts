import { Expr, isIdentifier } from "../../../lib/index.mjs";
import { getIdStr } from "../../../lib/syntax/get-id-str.mjs";

export const isPrimitiveFn = (expr?: Expr) => {
  if (!isIdentifier(expr)) return false;
  return new Set(["if", "=", "struct", "quote", "labeled-expr"]).has(
    getIdStr(expr)
  );
};
