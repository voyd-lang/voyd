import {
  type Expr,
  type Form,
  formCallsInternal,
  isForm,
  isIdentifierAtom,
} from "../ast/index.js";
import { cloneAttributes } from "../ast/syntax.js";
import type { BorrowContractAttribute } from "../attributes.js";
import { transformFormSequence } from "./sequence-transform.js";
import type { SyntaxMacro } from "./types.js";

type BorrowContractClause = keyof BorrowContractAttribute;

const clauseByLabel = new Map<string, BorrowContractClause>([
  ["reads", "reads"],
  ["mutates", "mutates"],
  ["returns_from", "returnsFrom"],
]);

export const borrowContractAttributeMacro: SyntaxMacro = (form) =>
  attachBorrowContractAttributes(form);

const attachBorrowContractAttributes = (form: Form): Form =>
  transformFormSequence({ form, transform: processSequence });

const processSequence = (
  elements: readonly Expr[],
  allowAttributes: boolean,
): { elements: Expr[]; changed: boolean } => {
  const result: Expr[] = [];
  let pending: BorrowContractAttribute | undefined;
  let changed = false;

  elements.forEach((element) => {
    const processed = isForm(element)
      ? attachBorrowContractAttributes(element)
      : element;
    changed ||= processed !== element;

    if (allowAttributes && isBorrowContractAttributeForm(processed)) {
      if (pending) {
        throw new Error("duplicate @borrow_contract attribute");
      }
      pending = parseBorrowContractAttribute(processed);
      changed = true;
      return;
    }

    if (pending && allowAttributes && isAttributeForm(processed)) {
      result.push(processed);
      return;
    }

    if (pending && allowAttributes) {
      if (!isForm(processed) || !isFunctionDeclForm(processed)) {
        throw new Error("@borrow_contract attribute must precede a function");
      }
      const attributes = cloneAttributes(processed.attributes) ?? {};
      if (attributes.borrowContract) {
        throw new Error("duplicate @borrow_contract attribute");
      }
      attributes.borrowContract = pending;
      processed.attributes = attributes;
      pending = undefined;
      changed = true;
    }

    result.push(processed);
  });

  if (pending && allowAttributes) {
    throw new Error("@borrow_contract attribute missing a function");
  }

  return { elements: result, changed };
};

const isAttributeForm = (expression: Expr): expression is Form =>
  isForm(expression) && expression.calls("@");

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

const isBorrowContractAttributeForm = (expr: Expr): expr is Form => {
  if (!isForm(expr) || !expr.calls("@")) {
    return false;
  }
  const target = expr.at(1);
  if (isIdentifierAtom(target)) {
    return target.value === "borrow_contract";
  }
  return (
    isForm(target) &&
    isIdentifierAtom(target.first) &&
    target.first.value === "borrow_contract"
  );
};

const parseBorrowContractAttribute = (form: Form): BorrowContractAttribute => {
  const target = form.at(1);
  if (!isForm(target) || !target.calls("borrow_contract")) {
    throw new Error("@borrow_contract requires at least one labeled clause");
  }

  const contract: Partial<Record<BorrowContractClause, readonly string[]>> = {};
  target.rest.forEach((argument) => {
    if (!isForm(argument) || !argument.calls(":")) {
      throw new Error("@borrow_contract arguments must be labeled with ':'");
    }
    const label = argument.at(1);
    if (!isIdentifierAtom(label)) {
      throw new Error("@borrow_contract argument labels must be identifiers");
    }
    const clause = clauseByLabel.get(label.value);
    if (!clause) {
      throw new Error(`unknown @borrow_contract clause '${label.value}'`);
    }
    if (contract[clause]) {
      throw new Error(`duplicate @borrow_contract '${label.value}:' clause`);
    }
    contract[clause] = parseRegionList(argument.at(2), label.value);
  });

  return contract;
};

const parseRegionList = (
  value: Expr | undefined,
  clause: string,
): readonly string[] => {
  if (isIdentifierAtom(value)) {
    return [value.value];
  }
  const fixed = fixedArrayPayload(value);
  if (!fixed) {
    throw new Error(
      `@borrow_contract ${clause} must be a region identifier or an array of region identifiers`,
    );
  }
  if (fixed.length === 0) {
    throw new Error(`@borrow_contract ${clause} array must not be empty`);
  }
  return fixed.map((entry) => {
    if (!isIdentifierAtom(entry)) {
      throw new Error(
        `@borrow_contract ${clause} entries must be region identifiers`,
      );
    }
    return entry.value;
  });
};

const fixedArrayPayload = (value: Expr | undefined): readonly Expr[] | null => {
  if (!isForm(value)) {
    return null;
  }
  if (formCallsInternal(value, "fixed_array_literal")) {
    return value.rest;
  }
  if (
    !value.calls("new_array_unchecked") &&
    !formCallsInternal(value, "new_array_unchecked")
  ) {
    return null;
  }
  const from = value.rest.find((entry) => {
    if (!isForm(entry) || !entry.calls(":")) {
      return false;
    }
    const label = entry.at(1);
    return isIdentifierAtom(label) && label.value === "from";
  });
  const payload = isForm(from) ? from.at(2) : undefined;
  return isForm(payload) && formCallsInternal(payload, "fixed_array_literal")
    ? payload.rest
    : null;
};
