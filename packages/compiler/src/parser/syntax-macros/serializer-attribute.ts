import {
  type Expr,
  type Form,
  isForm,
  isIdentifierAtom,
} from "../ast/index.js";
import { call } from "../ast/init-helpers.js";
import { cloneAttributes } from "../ast/syntax.js";
import type { SerializerAttribute } from "../attributes.js";
import type { SyntaxMacro } from "./types.js";
import { parseStringValue } from "./string-value.js";

type PendingSerializerAttribute = SerializerAttribute & { source: Form };

export const serializerAttributeMacro: SyntaxMacro = (form) =>
  attachSerializerAttributes(form);

const attachSerializerAttributes = (form: Form): Form => {
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
  let pending: PendingSerializerAttribute | null = null;
  let changed = false;

  for (const element of elements) {
    const processed = isForm(element)
      ? attachSerializerAttributes(element)
      : element;
    if (processed !== element) {
      changed = true;
    }

    if (allowAttributes && isSerializerAttributeForm(processed)) {
      if (pending) {
        throw new Error("duplicate @serializer attribute");
      }
      pending = parseSerializerAttribute(processed);
      changed = true;
      continue;
    }

    if (pending && allowAttributes) {
      const kind = isForm(processed) ? getTypeDeclKind(processed) : null;
      if (kind === "trait") {
        throw new Error("@serializer is not supported on trait declarations");
      }
      if (kind) {
        attachSerializerAttribute(processed, pending);
        changed = true;
        pending = null;
      } else {
        throw new Error("@serializer attribute must precede a type");
      }
    }

    result.push(processed);
  }

  if (pending && allowAttributes) {
    throw new Error("@serializer attribute missing a type");
  }

  return { elements: result, changed };
};

const getTypeDeclKind = (form: Form): "obj" | "type" | "trait" | null => {
  const head = form.at(0);
  if (!isIdentifierAtom(head)) {
    return null;
  }

  if (head.value === "pub") {
    const keyword = form.at(1);
    if (!isIdentifierAtom(keyword)) {
      return null;
    }
    if (
      keyword.value === "obj" ||
      keyword.value === "type" ||
      keyword.value === "trait"
    ) {
      return keyword.value;
    }
    return null;
  }

  if (head.value === "obj" || head.value === "type" || head.value === "trait") {
    return head.value;
  }
  return null;
};

const isSerializerAttributeForm = (expr: Expr): expr is Form =>
  isForm(expr) && expr.calls("@") && isSerializerHead(expr.at(1));

const isSerializerHead = (expr?: Expr): boolean => {
  if (isIdentifierAtom(expr)) {
    return expr.value === "serializer";
  }
  if (!isForm(expr)) {
    return false;
  }
  const head = expr.at(0);
  return isIdentifierAtom(head) && head.value === "serializer";
};

const parseSerializerAttribute = (form: Form): PendingSerializerAttribute => {
  const target = form.at(1);
  const attributeCall = getAttributeCall(target);
  if (!attributeCall || attributeCall.name !== "serializer") {
    throw new Error("unsupported attribute");
  }
  const parsedArgs = parseSerializerArgs(attributeCall.args);
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

const parseSerializerArgs = (args: readonly Expr[]): SerializerAttribute => {
  if (args.length !== 3) {
    throw new Error("@serializer requires format id, encode fn, and decode fn");
  }

  const formatId = parseStringValue(args[0]);
  if (!formatId) {
    throw new Error("@serializer format id must be a string");
  }

  return {
    formatId,
    encode: args[1]!,
    decode: args[2]!,
  };
};

const attachSerializerAttribute = (
  form: Form,
  attr: PendingSerializerAttribute
): void => {
  const attributes = cloneAttributes(form.attributes) ?? {};
  if ((attributes as { serializer?: unknown }).serializer) {
    throw new Error("duplicate @serializer attribute");
  }
  (attributes as { serializer: SerializerAttribute }).serializer = {
    formatId: attr.formatId,
    encode: attr.encode,
    decode: attr.decode,
  };
  form.attributes = attributes;
};
