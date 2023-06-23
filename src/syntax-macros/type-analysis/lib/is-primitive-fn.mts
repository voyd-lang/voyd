import { Expr } from "../../../lib/index.mjs";
import { getIdStr } from "../../../lib/syntax/get-id-str.mjs";

export const isPrimitiveFn = (expr?: Expr) => {
  if (!expr?.isIdentifier()) return false;
  return new Set(["if", "=", "struct", "quote", "labeled-expr"]).has(
    getIdStr(expr)
  );
};
