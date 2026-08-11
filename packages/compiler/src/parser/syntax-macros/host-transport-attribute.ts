import {
  type Expr,
  type Form,
  isForm,
  isIdentifierAtom,
  isIntAtom,
} from "../ast/index.js";
import { cloneAttributes } from "../ast/syntax.js";
import { parseStringValue } from "../string-value.js";
import { transformFormSequence } from "./sequence-transform.js";
import type { SyntaxMacro } from "./types.js";

export type HostTransportAttribute = { id: string; version: number };

export const hostTransportAttributeMacro: SyntaxMacro = (form) =>
  attachHostTransportAttributes(form);

const attachHostTransportAttributes = (form: Form): Form =>
  transformFormSequence({ form, transform: processSequence });

const processSequence = (
  elements: readonly Expr[],
  allowAttributes: boolean,
): { elements: Expr[]; changed: boolean } => {
  const result: Expr[] = [];
  let pending: HostTransportAttribute | undefined;
  let changed = false;
  for (const element of elements) {
    const processed = isForm(element)
      ? attachHostTransportAttributes(element)
      : element;
    if (processed !== element) changed = true;
    if (allowAttributes && isHostTransportAttributeForm(processed)) {
      if (pending) throw new Error("duplicate @host_transport attribute");
      pending = parseHostTransportAttribute(processed);
      changed = true;
      continue;
    }
    if (pending && allowAttributes) {
      if (!isForm(processed) || !isObjectDeclForm(processed)) {
        throw new Error("@host_transport must precede an object declaration");
      }
      const attributes = cloneAttributes(processed.attributes) ?? {};
      if ((attributes as { hostTransport?: unknown }).hostTransport) {
        throw new Error("duplicate @host_transport attribute");
      }
      (attributes as { hostTransport: HostTransportAttribute }).hostTransport =
        pending;
      processed.attributes = attributes;
      pending = undefined;
      changed = true;
    }
    result.push(processed);
  }
  if (pending) throw new Error("@host_transport attribute missing an object");
  return { elements: result, changed };
};

const isObjectDeclForm = (form: Form): boolean => {
  const head = form.at(0);
  if (!isIdentifierAtom(head)) return false;
  if (head.value === "obj" || head.value === "val") return true;
  const keyword = form.at(1);
  return (
    head.value === "pub" &&
    isIdentifierAtom(keyword) &&
    (keyword.value === "obj" || keyword.value === "val")
  );
};

const isHostTransportAttributeForm = (expr: Expr): expr is Form => {
  if (!isForm(expr) || !expr.calls("@")) return false;
  const target = expr.at(1);
  if (isIdentifierAtom(target)) return target.value === "host_transport";
  const head = isForm(target) ? target.at(0) : undefined;
  return isIdentifierAtom(head) && head.value === "host_transport";
};

const parseHostTransportAttribute = (form: Form): HostTransportAttribute => {
  const target = form.at(1);
  const args = isForm(target) ? target.rest : [];
  let id: string | undefined;
  let version: number | undefined;
  args.forEach((arg) => {
    if (!isForm(arg) || !arg.calls(":")) {
      throw new Error("@host_transport arguments must be labeled with ':'");
    }
    const label = arg.at(1);
    if (!isIdentifierAtom(label)) {
      throw new Error("@host_transport argument labels must be identifiers");
    }
    const value = arg.at(2);
    if (label.value === "id") {
      if (id !== undefined) throw new Error("duplicate @host_transport id");
      const parsed = parseStringValue(value);
      if (parsed === null || parsed.length === 0) {
        throw new Error("@host_transport id must be a non-empty string");
      }
      id = parsed;
      return;
    }
    if (label.value === "version") {
      if (version !== undefined) {
        throw new Error("duplicate @host_transport version");
      }
      if (!isIntAtom(value) || !/^\d+$/.test(value.value)) {
        throw new Error("@host_transport version must be a positive integer");
      }
      version = Number(value.value);
      if (!Number.isSafeInteger(version) || version <= 0) {
        throw new Error("@host_transport version must be a positive integer");
      }
      return;
    }
    throw new Error(`unknown @host_transport argument '${label.value}'`);
  });
  if (id === undefined || version === undefined) {
    throw new Error("@host_transport requires id and version");
  }
  return { id, version };
};
