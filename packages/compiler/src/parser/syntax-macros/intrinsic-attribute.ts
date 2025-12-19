import {
  BoolAtom,
  IntAtom,
  type Expr,
  type Form,
  isForm,
  isIdentifierAtom,
  formCallsInternal,
} from "../ast/index.js";
import { call } from "../ast/init-helpers.js";
import { cloneAttributes } from "../ast/syntax.js";
import type { IntrinsicAttribute } from "../attributes.js";
import { SyntaxMacro } from "./types.js";

type PendingIntrinsicAttribute = IntrinsicAttribute & { source: Form };

export const intrinsicAttributeMacro: SyntaxMacro = (form) =>
  attachIntrinsicAttributes(form);

const attachIntrinsicAttributes = (form: Form): Form => {
  if (form.callsInternal("ast")) {
    const { elements, changed } = processSequence(form.rest, true);
    if (!changed) {
      return form;
    }
    const wrapped = call("ast", ...elements);
    wrapped.setLocation(form.location?.clone());
    wrapped.attributes = cloneAttributes(form.attributes);
    return wrapped;
  }

  const { elements, changed } = processSequence(
    form.toArray(),
    form.calls("block") || form.callsInternal("ast")
  );
  if (!changed) {
    return form;
  }
  const rebuilt = new (form.constructor as typeof Form)({
    location: form.location?.clone(),
    elements,
  });
  rebuilt.attributes = cloneAttributes(form.attributes);
  return rebuilt;
};

const processSequence = (
  elements: readonly Expr[],
  allowAttributes: boolean
): { elements: Expr[]; changed: boolean } => {
  const result: Expr[] = [];
  let pending: PendingIntrinsicAttribute | null = null;
  let changed = false;

  for (const element of elements) {
    const processed = isForm(element)
      ? attachIntrinsicAttributes(element)
      : element;
    if (processed !== element) {
      changed = true;
    }

    if (allowAttributes && isIntrinsicAttributeForm(processed)) {
      if (pending) {
        throw new Error("duplicate @intrinsic attribute");
      }
      pending = parseIntrinsicAttribute(processed);
      changed = true;
      continue;
    }

    if (pending && allowAttributes) {
      if (isForm(processed) && isFunctionDeclForm(processed)) {
        attachIntrinsicAttribute(processed, pending);
        changed = true;
        pending = null;
      } else {
        throw new Error("@intrinsic attribute must precede a function");
      }
    }

    result.push(processed);
  }

  if (pending && allowAttributes) {
    throw new Error("@intrinsic attribute missing a function");
  }

  return { elements: result, changed };
};

const isFunctionDeclForm = (form: Form): boolean => {
  const head = form.at(0);
  if (!isIdentifierAtom(head)) {
    return false;
  }

  if (head.value === "pub") {
    const keyword = form.at(1);
    return isIdentifierAtom(keyword) && keyword.value === "fn";
  }

  return head.value === "fn";
};

const isIntrinsicAttributeForm = (expr: Expr): expr is Form =>
  isForm(expr) && expr.calls("@") && isIntrinsicHead(expr.at(1));

const isIntrinsicHead = (expr?: Expr): boolean => {
  if (isIdentifierAtom(expr)) {
    return expr.value === "intrinsic";
  }

  if (!isForm(expr)) {
    return false;
  }

  const head = expr.at(0);
  return isIdentifierAtom(head) && head.value === "intrinsic";
};

const parseIntrinsicAttribute = (form: Form): PendingIntrinsicAttribute => {
  const target = form.at(1);
  const attributeCall = getAttributeCall(target);
  if (!attributeCall || attributeCall.name !== "intrinsic") {
    throw new Error("unsupported attribute");
  }

  const parsedArgs = parseIntrinsicArgs(attributeCall.args);
  return { ...parsedArgs, source: form };
};

const getAttributeCall = (
  expr?: Expr
): { name: string; args: readonly Expr[] } | null => {
  if (!expr) {
    return null;
  }

  if (isIdentifierAtom(expr)) {
    return { name: expr.value, args: [] };
  }

  if (isForm(expr)) {
    const head = expr.at(0);
    if (isIdentifierAtom(head)) {
      return { name: head.value, args: expr.rest };
    }
  }

  return null;
};

const parseIntrinsicArgs = (
  args: readonly Expr[]
): IntrinsicAttribute => {
  let name: string | undefined;
  let usesSignature: boolean | undefined;

  args.forEach((arg) => {
    if (!isForm(arg) || !arg.calls(":")) {
      throw new Error("@intrinsic arguments must be labeled with ':'");
    }

    const label = arg.at(1);
    if (!isIdentifierAtom(label)) {
      throw new Error("@intrinsic argument labels must be identifiers");
    }

    const value = arg.at(2);
    if (label.value === "name") {
      const parsedName = parseStringValue(value);
      if (parsedName === null) {
        throw new Error("@intrinsic name must be a string");
      }
      name = parsedName;
      return;
    }

    if (label.value === "uses_signature") {
      if (!isBoolAtom(value)) {
        throw new Error("@intrinsic uses_signature must be a boolean");
      }
      usesSignature = value.value === "true";
      return;
    }

    throw new Error(`unknown @intrinsic argument '${label.value}'`);
  });

  return {
    name,
    usesSignature,
  };
};

const parseStringValue = (expr?: Expr): string | null => {
  if (!expr) {
    return null;
  }

  if (isIdentifierAtom(expr)) {
    return expr.value;
  }

  if (
    !isForm(expr) ||
    (!expr.calls("new_string") && !expr.callsInternal("new_string"))
  ) {
    return null;
  }

  const rawValue = expr.at(1);
  if (!isForm(rawValue) || !formCallsInternal(rawValue, "object_literal")) {
    return null;
  }

  const fromField = rawValue.rest.find((entry) => {
    if (!isForm(entry) || !entry.calls(":")) {
      return false;
    }
    const key = entry.at(1);
    return isIdentifierAtom(key) && key.value === "from";
  });

  if (!fromField || !isForm(fromField)) {
    return null;
  }

  const fromValue = fromField.at(2);
  if (!isForm(fromValue)) {
    return null;
  }

  const codes: number[] = [];
  fromValue.rest.forEach((entry, index) => {
    if (index === 0 && isForm(entry) && entry.callsInternal("generics")) {
      return;
    }

    if (entry instanceof IntAtom) {
      const parsed = Number.parseInt(entry.value, 10);
      if (Number.isFinite(parsed)) {
        codes.push(parsed);
      }
      return;
    }

    if (isIdentifierAtom(entry)) {
      const parsed = Number.parseInt(entry.value, 10);
      if (Number.isFinite(parsed)) {
        codes.push(parsed);
      }
    }
  });

  if (codes.length === 0) {
    return null;
  }

  return String.fromCharCode(...codes);
};

const isBoolAtom = (expr?: Expr): expr is BoolAtom =>
  expr instanceof BoolAtom;

const attachIntrinsicAttribute = (
  form: Form,
  attr: PendingIntrinsicAttribute
): void => {
  const attributes = cloneAttributes(form.attributes) ?? {};
  if ((attributes as { intrinsic?: unknown }).intrinsic) {
    throw new Error("duplicate @intrinsic attribute");
  }

  attributes.intrinsic = {
    name: attr.name ?? inferFunctionName(form),
    usesSignature: attr.usesSignature ?? false,
  };
  form.attributes = attributes;
};

const inferFunctionName = (form: Form): string | undefined => {
  let index = 0;
  const first = form.at(0);
  if (isIdentifierAtom(first) && first.value === "pub") {
    index += 1;
  }

  const keyword = form.at(index);
  if (!isIdentifierAtom(keyword) || keyword.value !== "fn") {
    return undefined;
  }

  let signatureExpr: Expr | undefined = form.at(index + 1);
  let bodyExpr: Expr | undefined = form.at(index + 2);

  if (!bodyExpr && isForm(signatureExpr) && signatureExpr.calls("=")) {
    signatureExpr = signatureExpr.at(1);
  }

  return inferFunctionNameFromSignature(signatureExpr);
};

const inferFunctionNameFromSignature = (expr?: Expr): string | undefined => {
  if (!expr) {
    return undefined;
  }

  if (isIdentifierAtom(expr)) {
    return expr.value;
  }

  if (!isForm(expr)) {
    return undefined;
  }

  if (expr.calls("->")) {
    return inferFunctionNameFromSignature(expr.at(1));
  }

  const head = expr.at(0);
  return isIdentifierAtom(head) ? head.value : undefined;
};
