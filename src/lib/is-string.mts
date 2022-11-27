import { Expr } from "../parser.mjs";

export const isString = (expr: Expr) =>
  typeof expr === "string" && expr[0] === '"';
