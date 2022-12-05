import { Expr } from "../parser.mjs";

export const isFloat = (str: Expr): str is string => {
  if (typeof str !== "string") return false;
  return str.startsWith("/float");
};
