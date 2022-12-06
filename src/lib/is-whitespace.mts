import { Expr } from "../parser.mjs";

export const isWhitespace = (expr: Expr) => {
  if (typeof expr !== "string") return false;
  return /^\s/.test(expr);
};
