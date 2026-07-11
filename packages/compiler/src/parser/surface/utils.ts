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
} from "../ast/index.js";
import type { SourceSpan } from "../../diagnostics/index.js";
import { ParserSyntaxError } from "../errors.js";

export const isIdentifierWithValue = (
  expr: Expr | undefined,
  value: string,
): expr is IdentifierAtom => isIdentifierAtom(expr) && expr.value === value;

type ColonClause = {
  syntax: Form;
  labelExpr: Expr | undefined;
  valueExpr: Expr | undefined;
};

const whileCache = new WeakMap<Form, { condition: Expr; body: Expr }>();

const toColonClause = (expr: Expr | undefined): ColonClause | undefined => {
  if (!isForm(expr) || !expr.calls(":")) {
    return undefined;
  }

  return {
    syntax: expr,
    labelExpr: expr.at(1),
    valueExpr: expr.at(2),
  };
};

const expectClauseLabel = (clause: ColonClause, errorMessage: string): Expr => {
  if (!clause.labelExpr) {
    throw new ParserSyntaxError(errorMessage, clause.syntax.location);
  }

  return clause.labelExpr;
};

const expectClauseValue = (clause: ColonClause, errorMessage: string): Expr => {
  if (!clause.valueExpr) {
    throw new ParserSyntaxError(errorMessage, clause.syntax.location);
  }

  return clause.valueExpr;
};

export const parseWhileConditionAndBody = (
  form: Form,
  context = "while expression",
): { condition: Expr; body: Expr } => {
  const cached = whileCache.get(form);
  if (cached) return cached;
  const conditionExpr = form.at(1);
  if (!conditionExpr) {
    throw new ParserSyntaxError(`${context} missing condition`, form.location);
  }

  const explicitBodyExpr = form.at(2);
  if (explicitBodyExpr) {
    throw new ParserSyntaxError(
      `${context} requires clause-style syntax: 'while condition:'`,
      explicitBodyExpr.location,
    );
  }

  const caseClause = toColonClause(conditionExpr);
  if (!caseClause) {
    throw new ParserSyntaxError(
      `${context} requires clause-style syntax: 'while condition:'`,
      conditionExpr.location,
    );
  }

  const caseCondition = expectClauseLabel(
    caseClause,
    `${context} clause is missing a condition`,
  );
  const bodyExpr = expectClauseValue(
    caseClause,
    `${context} missing body expression`,
  );

  const parsed = {
    condition: caseCondition,
    body: bodyExpr,
  };
  whileCache.set(form, parsed);
  return parsed;
};

export type ParsedIfBranch = {
  condition: Expr;
  value: Expr;
};

type ParsedIf = { branches: ParsedIfBranch[]; defaultBranch?: Expr };
const ifCache = new WeakMap<Form, ParsedIf>();

export const parseIfBranches = (
  form: Form,
  context = "if expression",
): ParsedIf => {
  const cached = ifCache.get(form);
  if (cached) return cached;
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
        `${context} clause is missing a condition`,
      );
      const valueExpr = expectClauseValue(
        entry,
        `${context} clause is missing a value`,
      );

      if (isIdentifierWithValue(conditionExpr, "else")) {
        defaultBranch = valueExpr;
        return;
      }

      branches.push({ condition: conditionExpr, value: valueExpr });
    });

    if (!branches.length) {
      throw new ParserSyntaxError(
        `${context} missing then branch`,
        form.location,
      );
    }

    const parsed = { branches, defaultBranch };
    ifCache.set(form, parsed);
    return parsed;
  }

  const conditionExpr = form.at(1);
  if (!conditionExpr) {
    throw new ParserSyntaxError(`${context} missing condition`, form.location);
  }

  const branches: ParsedIfBranch[] = [];
  let defaultBranch: Expr | undefined;
  let pendingCondition: Expr | undefined = conditionExpr;

  const extractInlineThenBranch = (
    condition: Expr,
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
        throw new ParserSyntaxError(
          `${context} has 'then:' without a condition`,
          branch?.location ?? form.location,
        );
      }
      const valueExpr = expectClauseValue(
        clause,
        `${context} missing body expression after 'then:'`,
      );
      branches.push({ condition: pendingCondition, value: valueExpr });
      pendingCondition = undefined;
      continue;
    }

    if (isIdentifierWithValue(labelExpr, "elif")) {
      if (pendingCondition) {
        throw new ParserSyntaxError(
          `${context} requires 'then:' after a condition before 'elif:'`,
          branch?.location ?? form.location,
        );
      }
      const elifCondition = expectClauseValue(
        clause,
        `${context} missing body expression after 'elif:'`,
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
        throw new ParserSyntaxError(
          `${context} requires 'then:' after a condition before 'else:'`,
          branch?.location ?? form.location,
        );
      }
      defaultBranch = expectClauseValue(
        clause,
        `${context} missing body expression after 'else:'`,
      );
    }
  }

  if (pendingCondition) {
    throw new ParserSyntaxError(
      `${context} missing then branch`,
      form.location,
    );
  }

  if (!branches.length) {
    throw new ParserSyntaxError(
      `${context} missing then branch`,
      form.location,
    );
  }

  const parsed = { branches, defaultBranch };
  ifCache.set(form, parsed);
  return parsed;
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
  options?: { includeInternalIdentifiers?: boolean },
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
