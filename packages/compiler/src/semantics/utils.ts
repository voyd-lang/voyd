import {
  Form,
  type Expr,
  type IdentifierAtom,
  type Syntax,
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

export const parseWhileConditionAndBody = (
  form: Form,
  context = "while expression"
): { condition: Expr; body: Expr } => {
  const conditionExpr = form.at(1);
  if (!conditionExpr) {
    throw new Error(`${context} missing condition`);
  }

  const isCaseForm = isForm(conditionExpr) && conditionExpr.calls(":");
  if (!isCaseForm) {
    return {
      condition: conditionExpr,
      body: expectLabeledExpr(form.at(2), "do", context),
    };
  }

  const bodyExpr = conditionExpr.at(2);
  if (!bodyExpr) {
    throw new Error(`${context} missing body expression`);
  }

  const caseCondition = conditionExpr.at(1);
  if (!caseCondition) {
    throw new Error(`${context} clause is missing a condition`);
  }

  return {
    condition: caseCondition,
    body: bodyExpr,
  };
};

export type ParsedIfBranch = {
  condition: Expr;
  value: Expr;
};

export const parseIfBranches = (
  form: Form,
  context = "if expression"
): { branches: ParsedIfBranch[]; defaultBranch?: Expr } => {
  const clauseEntries = form
    .rest
    .filter((entry): entry is Form => isForm(entry) && entry.calls(":"));

  const hasLegacyLabels = clauseEntries.some((entry) => {
    const labelExpr = entry.at(1);
    return (
      isIdentifierWithValue(labelExpr, "then") ||
      isIdentifierWithValue(labelExpr, "elif")
    );
  });

  if (!hasLegacyLabels && clauseEntries.length > 0) {
    const branches: ParsedIfBranch[] = [];
    let defaultBranch: Expr | undefined;

    clauseEntries.forEach((entry) => {
      const conditionExpr = entry.at(1);
      const valueExpr = entry.at(2);
      if (!conditionExpr) {
        throw new Error(`${context} clause is missing a condition`);
      }
      if (!valueExpr) {
        throw new Error(`${context} clause is missing a value`);
      }

      if (isIdentifierWithValue(conditionExpr, "else")) {
        defaultBranch = valueExpr;
        return;
      }

      branches.push({ condition: conditionExpr, value: valueExpr });
    });

    if (!branches.length) {
      throw new Error(`${context} missing then branch`);
    }

    return { branches, defaultBranch };
  }

  const conditionExpr = form.at(1);
  if (!conditionExpr) {
    throw new Error(`${context} missing condition`);
  }

  const branches: ParsedIfBranch[] = [];
  let defaultBranch: Expr | undefined;
  let pendingCondition: Expr | undefined = conditionExpr;

  const extractInlineThenBranch = (
    condition: Expr
  ): { condition: Expr; value: Expr } | undefined => {
    if (!isForm(condition)) return undefined;
    const last = condition.last;
    if (!isForm(last)) return undefined;

    const maybeClause = last.last;
    if (!isForm(maybeClause) || !maybeClause.calls(":")) return undefined;
    const clauseLabel = maybeClause.at(1);
    const clauseValue = maybeClause.at(2);
    if (!isIdentifierWithValue(clauseLabel, "then") || !clauseValue) {
      return undefined;
    }

    const trimmedLast = last.slice(0, -1).unwrap();
    const rebuiltCondition = new Form({
      location: condition.location?.clone(),
      elements: [...condition.toArray().slice(0, -1), trimmedLast],
    }).unwrap();

    return { condition: rebuiltCondition, value: clauseValue };
  };

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
      const elifCondition = expectLabeledExpr(branch, "elif", context);
      const inlineThen = extractInlineThenBranch(elifCondition);
      if (inlineThen) {
        branches.push(inlineThen);
        pendingCondition = undefined;
        continue;
      }
      pendingCondition = elifCondition;
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
