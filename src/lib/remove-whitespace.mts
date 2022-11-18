import { AST, Expr } from "../parser.mjs";

export const removeWhitespace = (expr: Expr) => {
  if (typeof expr === "string") return expr;

  return expr.reduce((prev: AST, exp): AST => {
    if (exp === " " || exp === "\t" || exp === "\n") {
      return prev;
    }

    if (exp instanceof Array) {
      return [...prev, removeWhitespace(exp)];
    }

    return [...prev, exp];
  }, []);
};
