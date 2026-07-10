import {
  type Expr,
  type Form,
  isForm,
  isIdentifierAtom,
} from "../ast/index.js";
import { cloneAttributes } from "../ast/syntax.js";
import type { CompilerContractAttribute } from "../attributes.js";
import { parseStringValue } from "../string-value.js";
import { transformFormSequence } from "./sequence-transform.js";
import type { SyntaxMacro } from "./types.js";

type PendingCompilerContractAttribute = CompilerContractAttribute & {
  source: Form;
};

export const compilerContractAttributeMacro: SyntaxMacro = (form) =>
  attachCompilerContractAttributes(form);

const attachCompilerContractAttributes = (form: Form): Form =>
  transformFormSequence({ form, transform: processSequence });

const processSequence = (
  elements: readonly Expr[],
  allowAttributes: boolean,
): { elements: Expr[]; changed: boolean } => {
  const result: Expr[] = [];
  let pending: PendingCompilerContractAttribute | null = null;
  let changed = false;

  for (const element of elements) {
    const processed = isForm(element)
      ? attachCompilerContractAttributes(element)
      : element;
    if (processed !== element) {
      changed = true;
    }

    if (allowAttributes && isCompilerContractAttributeForm(processed)) {
      if (pending) {
        throw new Error("duplicate @compiler_contract attribute");
      }
      pending = parseCompilerContractAttribute(processed);
      changed = true;
      continue;
    }

    if (pending && allowAttributes) {
      if (isForm(processed) && isFunctionDeclForm(processed)) {
        attachCompilerContractAttribute(processed, pending);
        changed = true;
        pending = null;
      } else {
        throw new Error("@compiler_contract attribute must precede a function");
      }
    }

    result.push(processed);
  }

  if (pending && allowAttributes) {
    throw new Error("@compiler_contract attribute missing a function");
  }

  return { elements: result, changed };
};

const isFunctionDeclForm = (form: Form): boolean => {
  const head = form.at(0);
  if (!isIdentifierAtom(head)) {
    return false;
  }
  if (head.value === "fn") {
    return true;
  }
  if (!["pub", "api", "pri", "#"].includes(head.value)) {
    return false;
  }
  const keyword = form.at(1);
  return isIdentifierAtom(keyword) && keyword.value === "fn";
};

const isCompilerContractAttributeForm = (expr: Expr): expr is Form =>
  isForm(expr) && expr.calls("@") && isCompilerContractHead(expr.at(1));

const isCompilerContractHead = (expr?: Expr): boolean => {
  if (isIdentifierAtom(expr)) {
    return expr.value === "compiler_contract";
  }
  if (!isForm(expr)) {
    return false;
  }
  const head = expr.at(0);
  return isIdentifierAtom(head) && head.value === "compiler_contract";
};

const parseCompilerContractAttribute = (
  form: Form,
): PendingCompilerContractAttribute => {
  const target = form.at(1);
  if (!isForm(target) || !target.calls("compiler_contract")) {
    throw new Error("@compiler_contract requires an 'id:' argument");
  }

  let id: string | undefined;
  target.rest.forEach((arg) => {
    if (!isForm(arg) || !arg.calls(":")) {
      throw new Error("@compiler_contract arguments must be labeled with ':'");
    }
    const label = arg.at(1);
    if (!isIdentifierAtom(label)) {
      throw new Error("@compiler_contract argument labels must be identifiers");
    }
    if (label.value !== "id") {
      throw new Error(`unknown @compiler_contract argument '${label.value}'`);
    }
    if (id !== undefined) {
      throw new Error("duplicate @compiler_contract 'id:' argument");
    }
    const parsedId = parseStringValue(arg.at(2));
    if (parsedId === null) {
      throw new Error("@compiler_contract id must be a string");
    }
    id = parsedId;
  });

  if (id === undefined) {
    throw new Error("@compiler_contract requires an 'id:' argument");
  }
  return { id, source: form };
};

const attachCompilerContractAttribute = (
  form: Form,
  attr: PendingCompilerContractAttribute,
): void => {
  const attributes = cloneAttributes(form.attributes) ?? {};
  if (attributes.compilerContract) {
    throw new Error("duplicate @compiler_contract attribute");
  }
  attributes.compilerContract = { id: attr.id };
  form.attributes = attributes;
};
