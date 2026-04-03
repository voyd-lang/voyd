import { type Expr, type Form, isIdentifierAtom } from "../ast/index.js";
import { isOp } from "../grammar.js";

const STRUCTURAL_SURFACE_FORM_HEADS = new Set([
  "#",
  "=>",
  "api",
  "block",
  "eff",
  "fn",
  "if",
  "impl",
  "let",
  "macro_let",
  "match",
  "obj",
  "pri",
  "pub",
  "test",
  "trait",
  "try",
  "type",
  "use",
  "val",
  "var",
  "while",
]);

export const isCallLikeForm = (form: Form): boolean => {
  const head = form.first;
  return !(isIdentifierAtom(head) && isOp(head));
};

export const isStructuralSurfaceForm = (form: Form): boolean => {
  const head = form.first;
  return isIdentifierAtom(head) && STRUCTURAL_SURFACE_FORM_HEADS.has(head.value);
};

export const canTakeTrailingCallbackClauses = (form: Form): boolean =>
  !form.calls(":") && isCallLikeForm(form) && !isStructuralSurfaceForm(form);

export const isNonBindingOp = (expr: Expr | undefined): boolean =>
  isIdentifierAtom(expr) && isOp(expr) && !blockBindingOps.has(expr.value);

const blockBindingOps = new Set(["=>", ":", "="]);
