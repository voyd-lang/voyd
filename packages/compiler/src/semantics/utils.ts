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

type ColonClause = {
  labelExpr: Expr | undefined;
  valueExpr: Expr | undefined;
};

const toColonClause = (expr: Expr | undefined): ColonClause | undefined => {
  if (!isForm(expr) || !expr.calls(":")) {
    return undefined;
  }

  return {
    labelExpr: expr.at(1),
    valueExpr: expr.at(2),
  };
};

const expectColonClause = (
  expr: Expr | undefined,
  errorMessage: string
): ColonClause => {
  const clause = toColonClause(expr);
  if (!clause) {
    throw new Error(errorMessage);
  }

  return clause;
};

const expectClauseLabel = (clause: ColonClause, errorMessage: string): Expr => {
  if (!clause.labelExpr) {
    throw new Error(errorMessage);
  }

  return clause.labelExpr;
};

const expectClauseValue = (clause: ColonClause, errorMessage: string): Expr => {
  if (!clause.valueExpr) {
    throw new Error(errorMessage);
  }

  return clause.valueExpr;
};

export const expectLabeledExpr = (
  expr: Expr | undefined,
  label: string,
  context: string
): Expr => {
  if (!expr) {
    throw new Error(`${context} missing body expression`);
  }

  const clause = expectColonClause(
    expr,
    `${context} requires '${label}:' before the body`
  );
  const labelExpr = expectClauseLabel(
    clause,
    `${context} requires '${label}:' before the body`
  );

  if (!isIdentifierWithValue(labelExpr, label)) {
    throw new Error(`${context} requires '${label}:' before the body`);
  }

  return expectClauseValue(
    clause,
    `${context} missing body expression after '${label}:'`
  );
};

export const parseWhileConditionAndBody = (
  form: Form,
  context = "while expression"
): { condition: Expr; body: Expr } => {
  const conditionExpr = form.at(1);
  if (!conditionExpr) {
    throw new Error(`${context} missing condition`);
  }

  const explicitBodyExpr = form.at(2);
  if (explicitBodyExpr) {
    return {
      condition: conditionExpr,
      body: expectLabeledExpr(explicitBodyExpr, "do", context),
    };
  }

  const caseClause = toColonClause(conditionExpr);
  if (!caseClause) {
    throw new Error(`${context} requires 'do:' before the body`);
  }

  const caseCondition = expectClauseLabel(
    caseClause,
    `${context} clause is missing a condition`
  );
  const bodyExpr = expectClauseValue(caseClause, `${context} missing body expression`);

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
  const clauseEntries = form.rest
    .map(toColonClause)
    .filter((entry): entry is ColonClause => !!entry);

  const hasLegacyLabels = clauseEntries.some((entry) => {
    const labelExpr = entry.labelExpr;
    return (
      isIdentifierWithValue(labelExpr, "then") ||
      isIdentifierWithValue(labelExpr, "elif")
    );
  });

  if (!hasLegacyLabels && clauseEntries.length > 0) {
    const branches: ParsedIfBranch[] = [];
    let defaultBranch: Expr | undefined;

    clauseEntries.forEach((entry) => {
      const conditionExpr = expectClauseLabel(
        entry,
        `${context} clause is missing a condition`
      );
      const valueExpr = expectClauseValue(
        entry,
        `${context} clause is missing a value`
      );

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
    const clause = toColonClause(branch);
    if (!clause) continue;
    const labelExpr = clause.labelExpr;

    if (isIdentifierWithValue(labelExpr, "then")) {
      if (!pendingCondition) {
        throw new Error(`${context} has 'then:' without a condition`);
      }
      const valueExpr = expectClauseValue(
        clause,
        `${context} missing body expression after 'then:'`
      );
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
      const elifCondition = expectClauseValue(
        clause,
        `${context} missing body expression after 'elif:'`
      );
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
      defaultBranch = expectClauseValue(
        clause,
        `${context} missing body expression after 'else:'`
      );
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
