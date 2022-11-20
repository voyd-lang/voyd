import { AST, Expr } from "../parser.mjs";
import { isList } from "./is-list.mjs";

export const removeWhitespace = (expr: Expr) => {
  if (!isList(expr)) return expr;

  return expr.reduce((prev: AST, exp: Expr): AST => {
    if (exp === " " || exp === "\t" || exp === "\n") {
      return prev;
    }

    if (isList(exp)) {
      return [...prev, removeWhitespace(exp)];
    }

    return [...prev, exp];
  }, []);
};
