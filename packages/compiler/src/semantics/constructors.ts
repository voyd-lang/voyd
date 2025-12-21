import {
  type Expr,
  type Form,
  type IdentifierAtom,
  type InternalIdentifierAtom,
  formCallsInternal,
  isForm,
  isIdentifierAtom,
  isInternalIdentifierAtom,
} from "../parser/index.js";

export const extractConstructorTargetIdentifier = (
  expr: Expr | undefined
): IdentifierAtom | InternalIdentifierAtom | undefined => {
  if (isIdentifierAtom(expr) || isInternalIdentifierAtom(expr)) {
    return expr;
  }
  if (!isForm(expr)) {
    return undefined;
  }
  if (expr.calls("::")) {
    const member = expr.at(2);
    if (isIdentifierAtom(member) || isInternalIdentifierAtom(member)) {
      return member as IdentifierAtom | InternalIdentifierAtom;
    }
    if (
      isForm(member) &&
      (isIdentifierAtom(member.first) || isInternalIdentifierAtom(member.first))
    ) {
      return member.first as IdentifierAtom | InternalIdentifierAtom;
    }
  }
  if (isIdentifierAtom(expr.first) || isInternalIdentifierAtom(expr.first)) {
    return expr.first as IdentifierAtom | InternalIdentifierAtom;
  }
  if (formCallsInternal(expr, "generics")) {
    const target = expr.at(1);
    if (isIdentifierAtom(target) || isInternalIdentifierAtom(target)) {
      return target as IdentifierAtom | InternalIdentifierAtom;
    }
    if (
      isForm(target) &&
      (isIdentifierAtom(target.first) || isInternalIdentifierAtom(target.first))
    ) {
      return target.first as IdentifierAtom | InternalIdentifierAtom;
    }
  }
  return undefined;
};

export const literalProvidesAllFields = (
  literal: Form,
  fields: readonly { name: string }[]
): boolean => {
  const info = gatherLiteralFieldInfo(literal);
  if (info.hasSpread) {
    return false;
  }
  const expected = fields.map((field) => field.name);
  return expected.every((name) => info.fields.has(name));
};

const gatherLiteralFieldInfo = (
  literal: Form
): { fields: Set<string>; hasSpread: boolean } => {
  const fields = new Set<string>();
  let hasSpread = false;
  literal.rest.forEach((entry) => {
    if (isForm(entry) && entry.calls("...")) {
      hasSpread = true;
      return;
    }
    if (isForm(entry) && entry.calls(":")) {
      const nameExpr = entry.at(1);
      if (isIdentifierAtom(nameExpr)) {
        fields.add(nameExpr.value);
      }
      return;
    }
    if (isIdentifierAtom(entry)) {
      fields.add(entry.value);
    }
  });
  return { fields, hasSpread };
};
