import { CallForm, Expr, Form } from "../../ast/index.js";
import * as p from "../../ast/predicates.js";
import {
  isCallLikeForm,
  isNonBindingOp,
} from "../surface-forms.js";

export {
  isCallLikeForm,
  isNonBindingOp,
};

export const normalizeFormKind = (original: Expr, rebuilt: Form): Expr =>
  original instanceof CallForm ? rebuilt.toCall() : rebuilt;

export const rebuildSameKind = (original: Form, elements: Expr[]): Expr => {
  const rebuilt = new Form({
    location: original.location?.clone(),
    elements,
  });

  return original instanceof CallForm ? rebuilt.toCall() : rebuilt.unwrap();
};

export const unwrapSyntheticCall = (expr: Expr): Expr => {
  if (p.isForm(expr)) return expr.unwrap();
  return expr;
};
