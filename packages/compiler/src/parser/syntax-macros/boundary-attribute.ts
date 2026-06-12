import {
  type Expr,
  type Form,
  isForm,
  isIdentifierAtom,
} from "../ast/index.js";
import { cloneAttributes } from "../ast/syntax.js";
import type { BoundaryAttribute } from "../attributes.js";
import { parseStringValue } from "../string-value.js";
import { transformFormSequence } from "./sequence-transform.js";

type PendingBoundaryAttribute = BoundaryAttribute & { source: Form };

export const boundaryAttributeMacro = (form: Form): Form =>
  transformFormSequence({ form, transform: processSequence });

const processSequence = (
  elements: readonly Expr[],
  allowAttributes: boolean,
): { elements: Expr[]; changed: boolean } => {
  const result: Expr[] = [];
  let pending: PendingBoundaryAttribute | null = null;
  let changed = false;

  for (const element of elements) {
    const processed = isForm(element) ? boundaryAttributeMacro(element) : element;
    if (processed !== element) {
      changed = true;
    }

    if (allowAttributes && isBoundaryAttributeForm(processed)) {
      if (pending) {
        throw new Error("duplicate @boundary attribute");
      }
      pending = parseBoundaryAttribute(processed);
      changed = true;
      continue;
    }

    if (pending && allowAttributes) {
      const kind = isForm(processed) ? getBoundaryTargetDeclKind(processed) : null;
      if (kind) {
        attachBoundaryAttribute(processed as Form, pending, kind);
        changed = true;
        pending = null;
      } else {
        throw new Error("@boundary attribute must precede a type or function");
      }
    }

    result.push(processed);
  }

  if (pending && allowAttributes) {
    throw new Error("@boundary attribute missing a type or function");
  }

  return { elements: result, changed };
};

const getBoundaryTargetDeclKind = (
  form: Form,
): "fn" | "obj" | "value" | "type" | null => {
  const normalizeDeclKind = (
    keyword: string,
  ): "fn" | "obj" | "value" | "type" | null => {
    if (keyword === "fn" || keyword === "obj" || keyword === "type") {
      return keyword;
    }
    return keyword === "val" ? "value" : null;
  };

  const head = form.at(0);
  if (!isIdentifierAtom(head)) {
    return null;
  }
  if (head.value === "pub") {
    const keyword = form.at(1);
    return isIdentifierAtom(keyword) ? normalizeDeclKind(keyword.value) : null;
  }
  return normalizeDeclKind(head.value);
};

const isBoundaryAttributeForm = (expr: Expr): expr is Form =>
  isForm(expr) && expr.calls("@") && isBoundaryHead(expr.at(1));

const isBoundaryHead = (expr?: Expr): boolean => {
  if (isIdentifierAtom(expr)) {
    return expr.value === "boundary";
  }
  if (!isForm(expr)) {
    return false;
  }
  const head = expr.at(0);
  return isIdentifierAtom(head) && head.value === "boundary";
};

const parseBoundaryAttribute = (form: Form): PendingBoundaryAttribute => {
  const target = form.at(1);
  const attributeCall = getAttributeCall(target);
  if (!attributeCall || attributeCall.name !== "boundary") {
    throw new Error("unsupported attribute");
  }
  return { ...parseBoundaryArgs(attributeCall.args), source: form };
};

const getAttributeCall = (
  expr?: Expr,
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

const parseBoundaryArgs = (args: readonly Expr[]): BoundaryAttribute => {
  let type: BoundaryAttribute["type"] | undefined;
  let field: string | undefined;

  args.forEach((arg) => {
    if (!isForm(arg) || !arg.calls(":")) {
      throw new Error("@boundary arguments must be labeled with ':'");
    }

    const label = arg.at(1);
    if (!isIdentifierAtom(label)) {
      throw new Error("@boundary argument labels must be identifiers");
    }

    const value = arg.at(2);
    const parsed = parseStringValue(value);
    if (parsed === null) {
      throw new Error(`@boundary ${label.value} must be a string`);
    }

    if (label.value === "type") {
      if (parsed !== "value" && parsed !== "payload") {
        throw new Error(`unknown @boundary type '${parsed}'`);
      }
      type = parsed;
      return;
    }

    if (label.value === "field") {
      field = parsed;
      return;
    }

    throw new Error(`unknown @boundary argument '${label.value}'`);
  });

  if (!type) {
    throw new Error("@boundary requires a 'type:' argument");
  }
  if (type === "payload" && !field) {
    throw new Error("@boundary payload requires a 'field:' argument");
  }
  if (type !== "payload" && field) {
    throw new Error(`@boundary ${type} does not accept a 'field:' argument`);
  }
  return { type, ...(field ? { field } : {}) };
};

const attachBoundaryAttribute = (
  form: Form,
  attr: PendingBoundaryAttribute,
  targetKind: "fn" | "obj" | "value" | "type",
): void => {
  validateBoundaryTarget(attr, targetKind);
  const attributes = cloneAttributes(form.attributes) ?? {};
  if ((attributes as { boundary?: unknown }).boundary) {
    throw new Error("duplicate @boundary attribute");
  }
  (attributes as { boundary: BoundaryAttribute }).boundary = {
    type: attr.type,
    ...(attr.field ? { field: attr.field } : {}),
  };
  form.attributes = attributes;
};

const validateBoundaryTarget = (
  attr: PendingBoundaryAttribute,
  targetKind: "fn" | "obj" | "value" | "type",
): void => {
  if (targetKind === "fn") {
    throw new Error("@boundary does not apply to functions");
  }

  if (targetKind === "type") {
    if (attr.type !== "value") {
      throw new Error("@boundary on type aliases only supports type: \"value\"");
    }
    return;
  }
};
