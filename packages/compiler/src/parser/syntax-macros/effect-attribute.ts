import type { Expr, Form } from "../ast/index.js";
import { isForm, isIdentifierAtom } from "../ast/index.js";
import { cloneAttributes } from "../ast/syntax.js";
import type { EffectAttribute, OperationAttribute } from "../attributes.js";
import type { SyntaxMacro } from "./types.js";
import { parseStringValue } from "../string-value.js";
import { transformFormSequence } from "./sequence-transform.js";

type PendingEffectAttribute = EffectAttribute & { source: Form };
type PendingOperationAttribute = OperationAttribute & { source: Form };

export const effectAttributeMacro: SyntaxMacro = (form) => {
  const result = attachEffectAttributes(form);
  validateOperationAttributeTargets(result, false);
  return result;
};

const validateOperationAttributeTargets = (
  form: Form,
  inEffectBody: boolean,
): void => {
  const isEffect = isEffectDeclForm(form);
  const first = form.at(0);
  const effectBody = isEffect
    ? form.at(isIdentifierAtom(first) && first.value === "pub" ? 3 : 2)
    : undefined;
  form.toArray().forEach((entry) => {
    if (!isForm(entry)) return;
    const isDirectEffectOperation = inEffectBody;
    if (entry.attributes?.operation && !isDirectEffectOperation) {
      throw new Error("@operation can only annotate an effect operation");
    }
    validateOperationAttributeTargets(entry, isEffect && entry === effectBody);
  });
};

const attachEffectAttributes = (form: Form): Form =>
  transformFormSequence({ form, transform: processSequence });

const processSequence = (
  elements: readonly Expr[],
  allowAttributes: boolean,
): { elements: Expr[]; changed: boolean } => {
  const result: Expr[] = [];
  let pending: PendingEffectAttribute | PendingOperationAttribute | null = null;
  let changed = false;

  for (const element of elements) {
    const processed = isForm(element)
      ? attachEffectAttributes(element)
      : element;
    if (processed !== element) {
      changed = true;
    }

    if (
      allowAttributes &&
      (isEffectAttributeForm(processed) || isOperationAttributeForm(processed))
    ) {
      if (pending) {
        throw new Error("duplicate @effect attribute");
      }
      pending = isEffectAttributeForm(processed)
        ? parseEffectAttribute(processed)
        : parseOperationAttribute(processed);
      changed = true;
      continue;
    }

    if (pending && allowAttributes) {
      if (
        isForm(processed) &&
        isEffectAttributeForm(pending.source) &&
        isEffectDeclForm(processed)
      ) {
        attachEffectAttribute(processed, pending);
        changed = true;
        pending = null;
      } else if (
        isForm(processed) &&
        isOperationAttributeForm(pending.source)
      ) {
        attachOperationAttribute(
          processed,
          pending as PendingOperationAttribute,
        );
        changed = true;
        pending = null;
      } else {
        throw new Error(
          "@effect must precede an effect declaration and @operation must precede an effect operation",
        );
      }
    }

    result.push(processed);
  }

  if (pending && allowAttributes) {
    throw new Error("@effect attribute missing an effect declaration");
  }

  return { elements: result, changed };
};

const isEffectDeclForm = (form: Form): boolean => {
  const head = form.at(0);
  if (!isIdentifierAtom(head)) {
    return false;
  }
  if (head.value === "pub") {
    const keyword = form.at(1);
    return isIdentifierAtom(keyword) && keyword.value === "eff";
  }
  return head.value === "eff";
};

const isEffectAttributeForm = (expr: Expr): expr is Form =>
  isForm(expr) && expr.calls("@") && isEffectHead(expr.at(1));

const isOperationAttributeForm = (expr: Expr): expr is Form =>
  isForm(expr) && expr.calls("@") && isOperationHead(expr.at(1));

const isOperationHead = (expr?: Expr): boolean =>
  isIdentifierAtom(expr)
    ? expr.value === "operation"
    : (() => {
        const head = isForm(expr) ? expr.at(0) : undefined;
        return isIdentifierAtom(head) && head.value === "operation";
      })();

const isEffectHead = (expr?: Expr): boolean => {
  if (isIdentifierAtom(expr)) {
    return expr.value === "effect";
  }
  if (!isForm(expr)) {
    return false;
  }
  const head = expr.at(0);
  return isIdentifierAtom(head) && head.value === "effect";
};

const parseEffectAttribute = (form: Form): PendingEffectAttribute => {
  const target = form.at(1);
  const attributeCall = getAttributeCall(target);
  if (!attributeCall || attributeCall.name !== "effect") {
    throw new Error("unsupported attribute");
  }
  const parsedArgs = parseEffectArgs(attributeCall.args);
  return { ...parsedArgs, source: form };
};

const parseOperationAttribute = (form: Form): PendingOperationAttribute => {
  const attributeCall = getAttributeCall(form.at(1));
  if (!attributeCall || attributeCall.name !== "operation") {
    throw new Error("unsupported attribute");
  }
  if (attributeCall.args.length !== 1) {
    throw new Error('@operation requires exactly id: "..."');
  }
  const arg = attributeCall.args[0];
  const label = isForm(arg) ? arg.at(1) : undefined;
  if (
    !isForm(arg) ||
    !arg.calls(":") ||
    !isIdentifierAtom(label) ||
    label.value !== "id"
  ) {
    throw new Error('@operation arguments must be id: "..."');
  }
  const id = parseStringValue(arg.at(2));
  if (!id || id.includes("::")) {
    throw new Error("@operation id must be a non-empty string without '::'");
  }
  return { id, source: form };
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

const parseEffectArgs = (args: readonly Expr[]): EffectAttribute => {
  let id: string | undefined;

  args.forEach((arg) => {
    if (!isForm(arg) || !arg.calls(":")) {
      throw new Error("@effect arguments must be labeled with ':'");
    }

    const label = arg.at(1);
    if (!isIdentifierAtom(label)) {
      throw new Error("@effect argument labels must be identifiers");
    }

    const value = arg.at(2);
    if (label.value === "id") {
      const parsed = parseStringValue(value);
      if (parsed === null) {
        throw new Error("@effect id must be a string");
      }
      id = parsed;
      return;
    }

    throw new Error(`unknown @effect argument '${label.value}'`);
  });

  return { id };
};

const attachEffectAttribute = (
  form: Form,
  attr: PendingEffectAttribute,
): void => {
  const attributes = cloneAttributes(form.attributes) ?? {};
  if ((attributes as { effect?: unknown }).effect) {
    throw new Error("duplicate @effect attribute");
  }

  attributes.effect = {
    id: attr.id,
  };
  form.attributes = attributes;
};

const attachOperationAttribute = (
  form: Form,
  attr: PendingOperationAttribute,
): void => {
  const attributes = cloneAttributes(form.attributes) ?? {};
  if ((attributes as { operation?: unknown }).operation) {
    throw new Error("duplicate @operation attribute");
  }
  attributes.operation = { id: attr.id };
  form.attributes = attributes;
};
