import {
  type Expr,
  type Form,
  isForm,
  isIdentifierAtom,
} from "../ast/index.js";
import { cloneAttributes } from "../ast/syntax.js";
import { transformFormSequence } from "./sequence-transform.js";
import type { SyntaxMacro } from "./types.js";

export const isolatedAttributeMacro: SyntaxMacro = (form) =>
  attachIsolatedAttributes(form);

const attachIsolatedAttributes = (form: Form): Form =>
  transformFormSequence({ form, transform: processSequence });

const processSequence = (
  elements: readonly Expr[],
  allowAttributes: boolean,
): { elements: Expr[]; changed: boolean } => {
  const result: Expr[] = [];
  let pending = false;
  let changed = false;

  for (const element of elements) {
    const processed = isForm(element)
      ? attachIsolatedAttributes(element)
      : element;
    if (processed !== element) changed = true;

    if (allowAttributes && isIsolatedAttributeForm(processed)) {
      if (pending) throw new Error("duplicate @isolated attribute");
      validateIsolatedAttribute(processed);
      pending = true;
      changed = true;
      continue;
    }

    if (pending && allowAttributes) {
      if (!isForm(processed) || !isFunctionDeclForm(processed)) {
        throw new Error("@isolated attribute must precede a trait method");
      }
      const attributes = cloneAttributes(processed.attributes) ?? {};
      if (attributes.isolated) throw new Error("duplicate @isolated attribute");
      attributes.isolated = true;
      processed.attributes = attributes;
      pending = false;
      changed = true;
    }

    result.push(processed);
  }

  if (pending && allowAttributes) {
    throw new Error("@isolated attribute missing a trait method");
  }
  return { elements: result, changed };
};

const isIsolatedAttributeForm = (expr: Expr): expr is Form =>
  isForm(expr) && expr.calls("@") && isIsolatedHead(expr.at(1));

const isIsolatedHead = (expr?: Expr): boolean => {
  if (isIdentifierAtom(expr)) return expr.value === "isolated";
  if (!isForm(expr)) return false;
  const head = expr.at(0);
  return isIdentifierAtom(head) && head.value === "isolated";
};

const validateIsolatedAttribute = (form: Form): void => {
  const target = form.at(1);
  if (isForm(target) && target.length > 1) {
    throw new Error("@isolated does not accept arguments");
  }
};

const isFunctionDeclForm = (form: Form): boolean => {
  const head = form.at(0);
  if (!isIdentifierAtom(head)) return false;
  if (head.value === "fn") return true;
  if (!["pub", "api", "pri", "#"].includes(head.value)) return false;
  const keyword = form.at(1);
  return isIdentifierAtom(keyword) && keyword.value === "fn";
};
