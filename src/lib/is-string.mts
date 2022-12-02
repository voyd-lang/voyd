import { Expr } from "../parser.mjs";

export const isString = (expr: Expr): expr is string =>
  typeof expr === "string" && expr[0] === '"';
