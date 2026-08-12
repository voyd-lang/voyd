import {
  type Expr,
  type Form,
  isForm,
  isIdentifierAtom,
  isIntAtom,
} from "../ast/index.js";
import { cloneAttributes } from "../ast/syntax.js";
import type { CompilerImplementationAttribute } from "../attributes.js";
import { parseStringValue } from "../string-value.js";
import { transformFormSequence } from "./sequence-transform.js";
import type { SyntaxMacro } from "./types.js";

type PendingCompilerImplementationAttribute =
  CompilerImplementationAttribute & { source: Form };

export const compilerImplementationAttributeMacro: SyntaxMacro = (form) =>
  attachCompilerImplementationAttributes(form);

const attachCompilerImplementationAttributes = (form: Form): Form =>
  transformFormSequence({ form, transform: processSequence });

const processSequence = (
  elements: readonly Expr[],
  allowAttributes: boolean,
): { elements: Expr[]; changed: boolean } => {
  const result: Expr[] = [];
  let pending: PendingCompilerImplementationAttribute | undefined;
  let changed = false;

  for (const element of elements) {
    const processed = isForm(element)
      ? attachCompilerImplementationAttributes(element)
      : element;
    if (processed !== element) changed = true;

    if (allowAttributes && isCompilerImplementationAttributeForm(processed)) {
      if (pending) throw new Error("duplicate @compiler_impl attribute");
      pending = parseCompilerImplementationAttribute(processed);
      changed = true;
      continue;
    }

    if (pending && allowAttributes) {
      if (!isForm(processed) || !isImplDeclForm(processed)) {
        throw new Error("@compiler_impl attribute must precede an impl");
      }
      const attributes = cloneAttributes(processed.attributes) ?? {};
      if (attributes.compilerImplementation) {
        throw new Error("duplicate @compiler_impl attribute");
      }
      attributes.compilerImplementation = {
        id: pending.id,
        version: pending.version,
      };
      processed.attributes = attributes;
      pending = undefined;
      changed = true;
    }
    result.push(processed);
  }

  if (pending) throw new Error("@compiler_impl attribute missing an impl");
  return { elements: result, changed };
};

const isImplDeclForm = (form: Form): boolean => {
  const head = form.at(0);
  if (!isIdentifierAtom(head)) return false;
  if (head.value === "impl") return true;
  const keyword = form.at(1);
  return (
    head.value === "pub" &&
    isIdentifierAtom(keyword) &&
    keyword.value === "impl"
  );
};

const isCompilerImplementationAttributeForm = (expr: Expr): expr is Form => {
  if (!isForm(expr) || !expr.calls("@")) return false;
  const target = expr.at(1);
  if (isIdentifierAtom(target)) return target.value === "compiler_impl";
  const head = isForm(target) ? target.at(0) : undefined;
  return isIdentifierAtom(head) && head.value === "compiler_impl";
};

const parseCompilerImplementationAttribute = (
  form: Form,
): PendingCompilerImplementationAttribute => {
  const target = form.at(1);
  const args = isForm(target) ? target.rest : [];
  let id: string | undefined;
  let version: number | undefined;

  args.forEach((arg) => {
    if (!isForm(arg) || !arg.calls(":")) {
      throw new Error("@compiler_impl arguments must be labeled with ':'");
    }
    const label = arg.at(1);
    if (!isIdentifierAtom(label)) {
      throw new Error("@compiler_impl argument labels must be identifiers");
    }
    const value = arg.at(2);
    if (label.value === "id") {
      if (id !== undefined) throw new Error("duplicate @compiler_impl id");
      const parsed = parseStringValue(value);
      if (parsed === null || parsed.length === 0) {
        throw new Error("@compiler_impl id must be a non-empty string");
      }
      id = parsed;
      return;
    }
    if (label.value === "version") {
      if (version !== undefined) {
        throw new Error("duplicate @compiler_impl version");
      }
      if (!isIntAtom(value) || !/^\d+$/.test(value.value)) {
        throw new Error("@compiler_impl version must be a positive integer");
      }
      version = Number(value.value);
      if (!Number.isSafeInteger(version) || version <= 0) {
        throw new Error("@compiler_impl version must be a positive integer");
      }
      return;
    }
    throw new Error(`unknown @compiler_impl argument '${label.value}'`);
  });

  if (id === undefined || version === undefined) {
    throw new Error("@compiler_impl requires id and version");
  }
  return { id, version, source: form };
};
