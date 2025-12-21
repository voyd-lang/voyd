import { CallForm, Expr, Form, isIdentifierAtom } from "../../ast/index.js";
import * as p from "../../ast/predicates.js";
import { isOp } from "../../grammar.js";

export const normalizeFormKind = (original: Expr, rebuilt: Form): Expr =>
  original instanceof CallForm ? rebuilt.toCall() : rebuilt;

/**
 * Returns true if `form` can be treated as a call-like list expression.
 * Used by handler clause and trailing-block hoisting rewrites.
 */
export const isCallLikeForm = (form: Form) => {
  const head = form.first;
  if (isIdentifierAtom(head) && isOp(head)) {
    return false;
  }

  return true;
};

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

export const isBlockBindingOp = (expr?: Expr) =>
  isIdentifierAtom(expr) && blockBindingOps.has(expr.value);

export const isNonBindingOp = (expr?: Expr) =>
  isIdentifierAtom(expr) && isOp(expr) && !isBlockBindingOp(expr);

const blockBindingOps = new Set(["=>", ":", "="]);
