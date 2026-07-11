import {
  type Form,
  isForm,
  isIdentifierAtom,
  isInternalIdentifierAtom,
} from "../ast/index.js";

export type SurfaceFormRole =
  | "object"
  | "lambda"
  | "if"
  | "while"
  | "match"
  | "for"
  | "try"
  | "clause-container"
  | "non-call"
  | "call";

const NON_CALL_HEADS = new Set([
  "block",
  "fn",
  "return",
  "resume",
  "perform",
  "->",
  "::",
  ".",
  "=",
  "as",
  "~",
  ":",
  "?:",
  "let",
  "var",
]);

export const classifySurfaceForm = (form: Form): SurfaceFormRole => {
  if (form.callsInternal("object_literal")) return "object";
  if (form.calls("=>")) return "lambda";
  if (form.calls("if")) return "if";
  if (form.calls("while")) return "while";
  if (form.calls("match")) return "match";
  if (form.calls("for")) return "for";
  if (form.calls("try")) return "try";
  if (containsBlockClause(form)) return "clause-container";
  const head = form.at(0);
  if (isInternalIdentifierAtom(head)) return "non-call";
  if (isIdentifierAtom(head) && NON_CALL_HEADS.has(head.value)) {
    return "non-call";
  }
  return "call";
};

const containsBlockClause = (form: Form): boolean =>
  form.rest.some((entry) => {
    if (!isForm(entry) || !entry.calls(":")) return false;
    const value = entry.at(2);
    return isForm(value) && value.calls("block");
  });
