import type { Expr, Form, IdentifierAtom, Syntax } from "../parser/index.js";
import {
  isBoolAtom,
  isFloatAtom,
  isForm,
  isIdentifierAtom,
  isInternalIdentifierAtom,
  isIntAtom,
  isStringAtom,
} from "../parser/index.js";
import type { SourceSpan } from "./ids.js";

export const isIdentifierWithValue = (
  expr: Expr | undefined,
  value: string
): expr is IdentifierAtom => isIdentifierAtom(expr) && expr.value === value;

export const expectLabeledExpr = (
  expr: Expr | undefined,
  label: string,
  context: string
): Expr => {
  if (!expr) {
    throw new Error(`${context} missing body expression`);
  }

  if (!isForm(expr) || !expr.calls(":")) {
    throw new Error(`${context} requires '${label}:' before the body`);
  }

  const labelExpr = expr.at(1);
  const value = expr.at(2);

  if (!isIdentifierWithValue(labelExpr, label)) {
    throw new Error(`${context} requires '${label}:' before the body`);
  }

  if (!value) {
    throw new Error(`${context} missing body expression after '${label}:'`);
  }

  return value;
};

export type ParsedIfBranch = {
  condition: Expr;
  value: Expr;
};

export const parseIfBranches = (
  form: Form,
  context = "if expression"
): { branches: ParsedIfBranch[]; defaultBranch?: Expr } => {
  const conditionExpr = form.at(1);
  if (!conditionExpr) {
    throw new Error(`${context} missing condition`);
  }

  const branches: ParsedIfBranch[] = [];
  let defaultBranch: Expr | undefined;
  let pendingCondition: Expr | undefined = conditionExpr;

  for (let i = 2; i < form.length; i += 1) {
    const branch = form.at(i);
    if (!isForm(branch) || !branch.calls(":")) continue;
    const labelExpr = branch.at(1);

    if (isIdentifierWithValue(labelExpr, "then")) {
      if (!pendingCondition) {
        throw new Error(`${context} has 'then:' without a condition`);
      }
      const valueExpr = expectLabeledExpr(branch, "then", context);
      branches.push({ condition: pendingCondition, value: valueExpr });
      pendingCondition = undefined;
      continue;
    }

    if (isIdentifierWithValue(labelExpr, "elif")) {
      if (pendingCondition) {
        throw new Error(
          `${context} requires 'then:' after a condition before 'elif:'`
        );
      }
      pendingCondition = expectLabeledExpr(branch, "elif", context);
      continue;
    }

    if (isIdentifierWithValue(labelExpr, "else")) {
      if (pendingCondition) {
        throw new Error(
          `${context} requires 'then:' after a condition before 'else:'`
        );
      }
      defaultBranch = expectLabeledExpr(branch, "else", context);
    }
  }

  if (pendingCondition) {
    throw new Error(`${context} missing then branch`);
  }

  if (!branches.length) {
    throw new Error(`${context} missing then branch`);
  }

  return { branches, defaultBranch };
};

export const toSourceSpan = (syntax?: Syntax): SourceSpan => {
  const location = syntax?.location;
  if (!location) {
    return { file: "<unknown>", start: 0, end: 0 };
  }
  return {
    file: location.filePath,
    start: location.startIndex,
    end: location.endIndex,
  };
};

export const formatTypeAnnotation = (
  expr?: Expr,
  options?: { includeInternalIdentifiers?: boolean }
): string => {
  if (!expr) {
    return "<inferred>";
  }
  if (
    isIdentifierAtom(expr) ||
    (options?.includeInternalIdentifiers === true &&
      isInternalIdentifierAtom(expr))
  ) {
    return expr.value;
  }
  if (isIntAtom(expr) || isFloatAtom(expr)) {
    return expr.value;
  }
  if (isStringAtom(expr)) {
    return JSON.stringify(expr.value);
  }
  if (isBoolAtom(expr)) {
    return String(expr.value);
  }
  if (isForm(expr)) {
    return `(${expr
      .toArray()
      .map((entry) => formatTypeAnnotation(entry, options))
      .join(" ")})`;
  }
  return "<expr>";
};
