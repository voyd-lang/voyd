import {
  IntAtom,
  type Expr,
  type Form,
  isForm,
  isIdentifierAtom,
  formCallsInternal,
} from "../ast/index.js";
import { call } from "../ast/init-helpers.js";
import { cloneAttributes } from "../ast/syntax.js";
import { SyntaxMacro } from "./types.js";

type PendingIntrinsicTypeAttribute = { intrinsicType: string; source: Form };

export const intrinsicTypeAttributeMacro: SyntaxMacro = (form) =>
  attachIntrinsicTypeAttributes(form);

const attachIntrinsicTypeAttributes = (form: Form): Form => {
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
  let pending: PendingIntrinsicTypeAttribute | null = null;
  let changed = false;

  for (const element of elements) {
    const processed = isForm(element)
      ? attachIntrinsicTypeAttributes(element)
      : element;
    if (processed !== element) {
      changed = true;
    }

    if (allowAttributes && isIntrinsicTypeAttributeForm(processed)) {
      if (pending) {
        throw new Error("duplicate @intrinsic_type attribute");
      }
      pending = parseIntrinsicTypeAttribute(processed);
      changed = true;
      continue;
    }

    if (pending && allowAttributes) {
      if (isForm(processed) && isTypeDeclForm(processed)) {
        attachIntrinsicTypeAttribute(processed, pending);
        changed = true;
        pending = null;
      } else {
        throw new Error("@intrinsic_type attribute must precede a type");
      }
    }

    result.push(processed);
  }

  if (pending && allowAttributes) {
    throw new Error("@intrinsic_type attribute missing a type");
  }

  return { elements: result, changed };
};

const isTypeDeclForm = (form: Form): boolean => {
  const head = form.at(0);
  if (!isIdentifierAtom(head)) {
    return false;
  }

  if (head.value === "pub") {
    const keyword = form.at(1);
    return (
      isIdentifierAtom(keyword) &&
      (keyword.value === "obj" || keyword.value === "type" || keyword.value === "trait")
    );
  }

  return head.value === "obj" || head.value === "type" || head.value === "trait";
};

const isIntrinsicTypeAttributeForm = (expr: Expr): expr is Form =>
  isForm(expr) && expr.calls("@") && isIntrinsicTypeHead(expr.at(1));

const isIntrinsicTypeHead = (expr?: Expr): boolean => {
  if (isIdentifierAtom(expr)) {
    return expr.value === "intrinsic_type";
  }

  if (!isForm(expr)) {
    return false;
  }

  const head = expr.at(0);
  return isIdentifierAtom(head) && head.value === "intrinsic_type";
};

const parseIntrinsicTypeAttribute = (form: Form): PendingIntrinsicTypeAttribute => {
  const target = form.at(1);
  const attributeCall = getAttributeCall(target);
  if (!attributeCall || attributeCall.name !== "intrinsic_type") {
    throw new Error("unsupported attribute");
  }

  const intrinsicType = parseIntrinsicTypeArgs(attributeCall.args);
  return { intrinsicType, source: form };
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

const parseIntrinsicTypeArgs = (args: readonly Expr[]): string => {
  if (args.length === 0) {
    throw new Error("@intrinsic_type requires an intrinsic type value");
  }

  if (args.length === 1) {
    const inline = parseStringValue(args[0]);
    if (inline) {
      return inline;
    }
  }

  let intrinsicType: string | undefined;
  args.forEach((arg) => {
    if (!isForm(arg) || !arg.calls(":")) {
      throw new Error("@intrinsic_type arguments must be labeled with ':'");
    }

    const label = arg.at(1);
    if (!isIdentifierAtom(label)) {
      throw new Error("@intrinsic_type argument labels must be identifiers");
    }

    const value = arg.at(2);
    if (label.value === "type") {
      const parsed = parseStringValue(value);
      if (parsed === null) {
        throw new Error("@intrinsic_type type must be a string");
      }
      intrinsicType = parsed;
      return;
    }

    throw new Error(`unknown @intrinsic_type argument '${label.value}'`);
  });

  if (!intrinsicType) {
    throw new Error("@intrinsic_type requires a 'type:' argument");
  }

  return intrinsicType;
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

const attachIntrinsicTypeAttribute = (
  form: Form,
  attr: PendingIntrinsicTypeAttribute
): void => {
  const attributes = cloneAttributes(form.attributes) ?? {};
  if ((attributes as { intrinsicType?: unknown }).intrinsicType) {
    throw new Error("duplicate @intrinsic_type attribute");
  }

  (attributes as { intrinsicType: string }).intrinsicType = attr.intrinsicType;
  form.attributes = attributes;
};

