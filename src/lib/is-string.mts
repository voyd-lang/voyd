import { Expr } from "../parser.mjs";

export const isStringLiteral = (expr: Expr): expr is string =>
  typeof expr === "string" && expr[0] === '"';
