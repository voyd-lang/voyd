import { type Expr, type Form, isForm } from "../../../parser/index.js";

export const ensureForm = (expr: Expr | undefined, message: string): Form => {
  if (!isForm(expr)) {
    throw new Error(message);
  }
  return expr;
};
