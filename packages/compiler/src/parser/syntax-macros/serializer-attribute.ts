import {
  type Expr,
  type Form,
  isForm,
  isIdentifierAtom,
} from "../ast/index.js";
import { call } from "../ast/init-helpers.js";
import { cloneAttributes } from "../ast/syntax.js";
import type { SerializerAttribute } from "../attributes.js";
import { SyntaxMacroError } from "./macro-error.js";
import type { SyntaxMacro } from "./types.js";
import { parseStringValue } from "./string-value.js";

type PendingSerializerAttribute = SerializerAttribute & { source: Form };

export const serializerAttributeMacro: SyntaxMacro = (form) =>
  attachSerializerAttributes(form);

export const stripSerializerAttributeForms = (form: Form): Form => {
  if (form.callsInternal("ast")) {
    const { elements, changed } = stripSequence(form.rest, true);
    if (!changed) {
      return form;
    }
    const wrapped = call("ast", ...elements);
    wrapped.setLocation(form.location?.clone());
    wrapped.attributes = cloneAttributes(form.attributes);
    return wrapped;
  }

  const { elements, changed } = stripSequence(
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

	    let serializerAttributeForm: Form | null = null;
	    if (allowAttributes && isSerializerAttributeForm(processed)) {
	      serializerAttributeForm = processed;
	    }
	    if (serializerAttributeForm) {
	      if (pending) {
	        throw new SyntaxMacroError(
	          "duplicate @serializer attribute",
	          serializerAttributeForm
	        );
	      }
	      pending = parseSerializerAttribute(serializerAttributeForm as Form);
	      changed = true;
	      continue;
	    }

	    if (pending && allowAttributes) {
	      const kind = isForm(processed) ? getTypeDeclKind(processed) : null;
	      if (kind === "trait") {
	        throw new SyntaxMacroError(
	          "@serializer is not supported on trait declarations",
	          pending.source
	        );
	      }
	      if (kind) {
	        attachSerializerAttribute(processed as Form, pending);
	        changed = true;
	        pending = null;
	      } else {
	        throw new SyntaxMacroError(
	          "@serializer attribute must precede a type",
	          pending.source
	        );
	      }
	    }

    result.push(processed);
  }

	  if (pending && allowAttributes) {
	    throw new SyntaxMacroError(
	      "@serializer attribute missing a type",
	      pending.source
	    );
	  }

  return { elements: result, changed };
};

const stripSequence = (
  elements: readonly Expr[],
  allowAttributes: boolean
): { elements: Expr[]; changed: boolean } => {
  const result: Expr[] = [];
  let changed = false;

  for (const element of elements) {
    const processed = isForm(element)
      ? stripSerializerAttributeForms(element)
      : element;
    if (processed !== element) {
      changed = true;
    }

    if (allowAttributes && isSerializerAttributeForm(processed)) {
      changed = true;
      continue;
    }

    result.push(processed);
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

const parseSerializerAttribute = (expr: Expr): PendingSerializerAttribute => {
  if (!isForm(expr)) {
    throw new SyntaxMacroError("serializer attribute requires a form");
  }
  const form = expr;
  const target = form.at(1);
  const attributeCall = getAttributeCall(target);
  if (!attributeCall || attributeCall.name !== "serializer") {
    throw new SyntaxMacroError("unsupported attribute", form);
  }
  try {
    const parsedArgs = parseSerializerArgs(attributeCall.args);
    return { ...parsedArgs, source: form };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new SyntaxMacroError(message, form);
  }
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
    throw new SyntaxMacroError(
      "@serializer requires format id, encode fn, and decode fn"
    );
  }

  const formatId = parseStringValue(args[0]);
  if (!formatId) {
    throw new SyntaxMacroError("@serializer format id must be a string");
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
    throw new SyntaxMacroError("duplicate @serializer attribute", form);
  }
  (attributes as { serializer: SerializerAttribute }).serializer = {
    formatId: attr.formatId,
    encode: attr.encode,
    decode: attr.decode,
  };
  form.attributes = attributes;
};
