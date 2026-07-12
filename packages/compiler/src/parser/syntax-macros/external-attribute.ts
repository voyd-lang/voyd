import type { Expr, Form } from "../ast/index.js";
import { isForm, isIdentifierAtom } from "../ast/index.js";
import { cloneAttributes } from "../ast/syntax.js";
import type { ExternalAttribute } from "../attributes.js";
import type { SyntaxMacro } from "./types.js";
import { parseStringValue } from "../string-value.js";
import { transformFormSequence } from "./sequence-transform.js";

export const EXTERNAL_INTRINSIC_NAME = "voyd_external";

type PendingExternalAttribute = ExternalAttribute & { source: Form };

export const externalAttributeMacro: SyntaxMacro = (form) =>
  attachExternalAttributes(form);

const attachExternalAttributes = (form: Form): Form =>
  transformFormSequence({ form, transform: processSequence });

const processSequence = (
  elements: readonly Expr[],
  allowAttributes: boolean,
): { elements: Expr[]; changed: boolean } => {
  const result: Expr[] = [];
  let pending: PendingExternalAttribute | null = null;
  let changed = false;

  for (const element of elements) {
    const processed = isForm(element)
      ? attachExternalAttributes(element)
      : element;
    if (processed !== element) changed = true;

    if (allowAttributes && isExternalAttributeForm(processed)) {
      if (pending) throw new Error("duplicate @external attribute");
      pending = parseExternalAttribute(processed);
      changed = true;
      continue;
    }

    if (pending && allowAttributes) {
      if (!isForm(processed) || (!isFunctionDeclForm(processed) && !isEffectDeclForm(processed))) {
        throw new Error("@external attribute must precede a function or effect declaration");
      }
      attachExternalAttribute(processed, pending);
      pending = null;
      changed = true;
    }

    result.push(processed);
  }

  if (pending && allowAttributes) {
    throw new Error("@external attribute missing a function or effect declaration");
  }

  return { elements: result, changed };
};

const isFunctionDeclForm = (form: Form): boolean => {
  const head = form.at(0);
  if (!isIdentifierAtom(head)) return false;
  if (head.value !== "pub") return head.value === "fn";
  const keyword = form.at(1);
  return isIdentifierAtom(keyword) && keyword.value === "fn";
};

const isEffectDeclForm = (form: Form): boolean => {
  const head = form.at(0);
  if (!isIdentifierAtom(head)) return false;
  if (head.value !== "pub") return head.value === "eff";
  const keyword = form.at(1);
  return isIdentifierAtom(keyword) && keyword.value === "eff";
};

const isExternalAttributeForm = (expr: Expr): expr is Form =>
  isForm(expr) && expr.calls("@") && isExternalHead(expr.at(1));

const isExternalHead = (expr?: Expr): boolean => {
  if (isIdentifierAtom(expr)) return expr.value === "external";
  if (!isForm(expr)) return false;
  const head = expr.at(0);
  return isIdentifierAtom(head) && head.value === "external";
};

const parseExternalAttribute = (form: Form): PendingExternalAttribute => {
  const target = form.at(1);
  const args = isForm(target) ? target.rest : [];
  let id: string | undefined;

  args.forEach((arg) => {
    if (!isForm(arg) || !arg.calls(":")) {
      throw new Error("@external arguments must be labeled with ':'");
    }
    const label = arg.at(1);
    if (!isIdentifierAtom(label)) {
      throw new Error("@external argument labels must be identifiers");
    }
    if (label.value !== "id") {
      throw new Error(`unknown @external argument '${label.value}'`);
    }
    const parsed = parseStringValue(arg.at(2));
    if (parsed === null) throw new Error("@external id must be a string");
    id = parsed;
  });

  if (!id) throw new Error("@external requires an 'id:' argument");
  return { id, source: form };
};

const attachExternalAttribute = (
  form: Form,
  attr: PendingExternalAttribute,
): void => {
  const attributes = cloneAttributes(form.attributes) ?? {};
  if ((attributes as { external?: unknown }).external) {
    throw new Error("duplicate @external attribute");
  }
  if ((attributes as { intrinsic?: unknown }).intrinsic) {
    throw new Error("@external cannot be combined with @intrinsic");
  }

  attributes.external = { id: attr.id };
  if (isEffectDeclForm(form)) {
    if ((attributes as { effect?: unknown }).effect) {
      throw new Error("@external effect cannot also use @effect");
    }
    attributes.effect = { id: attr.id };
    form.attributes = attributes;
    return;
  }

  const name = inferFunctionName(form);
  if (!name) throw new Error("@external function is missing a name");
  attributes.intrinsic = {
    name: EXTERNAL_INTRINSIC_NAME,
    usesSignature: true,
  };
  form.attributes = attributes;
};

const inferFunctionName = (form: Form): string | undefined => {
  let index = 0;
  const first = form.at(0);
  if (isIdentifierAtom(first) && first.value === "pub") index += 1;
  const keyword = form.at(index);
  if (!isIdentifierAtom(keyword) || keyword.value !== "fn") return undefined;
  return inferFunctionNameFromSignature(form.at(index + 1));
};

const inferFunctionNameFromSignature = (expr?: Expr): string | undefined => {
  if (!expr) return undefined;
  if (isIdentifierAtom(expr)) return expr.value;
  if (!isForm(expr)) return undefined;
  if (expr.calls("=")) return inferFunctionNameFromSignature(expr.at(1));
  if (expr.calls("->")) return inferFunctionNameFromSignature(expr.at(1));
  const head = expr.at(0);
  return isIdentifierAtom(head) ? head.value : undefined;
};
