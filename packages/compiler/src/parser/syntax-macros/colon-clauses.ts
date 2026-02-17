import { CallForm, type Expr, Form, isForm, isIdentifierAtom } from "../ast/index.js";
import * as p from "../ast/predicates.js";
import { isOp } from "../grammar.js";
import type { SyntaxMacro } from "./types.js";

const blockBindingOps = new Set([":", "=", "=>"]);

const isClause = (expr: Expr | undefined): expr is Form =>
  isForm(expr) && expr.calls(":") && expr.length >= 3;

const isClauseSuiteBlock = (expr: Expr | undefined): expr is Form => {
  if (!isForm(expr) || !expr.calls("block")) return false;
  const entries = expr.rest.filter((entry) => !p.isWhitespaceAtom(entry) && !p.isCommentAtom(entry));
  return entries.length > 0 && entries.every((entry) => isClause(entry));
};

const isCallLikeForm = (form: Form): boolean => {
  const head = form.first;
  return !(isIdentifierAtom(head) && isOp(head));
};

const isNonBindingOp = (expr: Expr | undefined): boolean =>
  isIdentifierAtom(expr) && isOp(expr) && !blockBindingOps.has(expr.value);

const isObjectLiteral = (expr: Expr | undefined): expr is Form =>
  isForm(expr) && expr.callsInternal("object_literal");

const clauseValueObjectLiteralHosts = new Set(["if", "while"]);

const canCallWithObjectLiteral = (expr: Expr | undefined): boolean => {
  if (!expr) {
    return false;
  }
  if (isIdentifierAtom(expr)) {
    return !expr.isQuoted && !isOp(expr);
  }
  if (!isForm(expr) || expr.callsInternal("paren") || expr.callsInternal("tuple")) {
    return false;
  }
  const head = expr.first;
  return isIdentifierAtom(head) && !head.isQuoted && !isOp(head);
};

const rebuildSameKind = (original: Form, elements: Expr[]): Form => {
  const rebuilt = new Form({
    location: original.location?.clone(),
    elements,
  });
  return original instanceof CallForm ? rebuilt.toCall() : rebuilt;
};

const withTrailingObjectLiteralValue = (
  clause: Form,
  objectLiteral: Form,
): Form => {
  const value = clause.at(2);
  if (!canCallWithObjectLiteral(value)) {
    return clause;
  }

  const mergedValue = new CallForm([value!, objectLiteral]);
  return rebuildSameKind(clause, [clause.at(0)!, clause.at(1)!, mergedValue]);
};

const mergeClauseObjectLiterals = (form: Form): Form => {
  const elements = form.toArray();
  const result: Expr[] = [];

  for (let index = 0; index < elements.length; index += 1) {
    let current = elements[index]!;
    if (isClause(current)) {
      const maybeObjectLiteral = elements[index + 1];
      if (isObjectLiteral(maybeObjectLiteral)) {
        const merged = withTrailingObjectLiteralValue(current, maybeObjectLiteral);
        if (merged !== current) {
          current = merged;
          index += 1;
        }
      }
    }
    result.push(current);
  }

  return rebuildSameKind(form, result);
};

const canMergeClauseObjectLiteralValues = (form: Form): boolean => {
  const head = form.first;
  return isIdentifierAtom(head) && clauseValueObjectLiteralHosts.has(head.value);
};

const attachClausesToRightmostCall = (expr: Form, clauses: Form[]): Form => {
  if (!expr.calls(":") && isCallLikeForm(expr)) {
    return rebuildSameKind(expr, [...expr.toArray(), ...clauses]);
  }

  const last = expr.last;
  if (!isForm(last) || !isNonBindingOp(expr.first)) {
    return expr;
  }

  const updatedLast = attachClausesToRightmostCall(last, clauses);
  if (updatedLast === last) {
    return expr;
  }

  const elements = expr.toArray();
  elements[elements.length - 1] = updatedLast;
  return rebuildSameKind(expr, elements);
};

const spliceTrailingClauseSuiteBlock = (form: Form): Form => {
  const last = form.last;
  if (!isClauseSuiteBlock(last)) {
    return form;
  }

  const clauses = (last as Form).rest.filter((entry) => isClause(entry)) as Form[];
  const trimmed = form.toArray().slice(0, -1);
  return rebuildSameKind(form, [...trimmed, ...clauses]);
};

const attachFollowingClauses = (form: Form): Form => {
  const elements = form.toArray();
  const result: Expr[] = [];

  for (let index = 0; index < elements.length; index += 1) {
    let current = elements[index]!;
    if (isClause(current)) {
      const maybeObjectLiteral = elements[index + 1];
      if (isObjectLiteral(maybeObjectLiteral)) {
        const merged = withTrailingObjectLiteralValue(current, maybeObjectLiteral);
        if (merged !== current) {
          current = merged;
          index += 1;
        }
      }
    }

    const previous = result.at(-1);
    if (isClause(current) && isForm(previous)) {
      result.pop();
      const collected: Form[] = [current];
      while (isClause(elements[index + 1] as Expr | undefined)) {
        index += 1;
        collected.push(elements[index] as Form);
      }

      const updated = attachClausesToRightmostCall(previous, collected);
      if (updated !== previous) {
        result.push(updated);
        continue;
      }

      result.push(previous, ...collected);
      continue;
    }

    result.push(current);
  }

  return rebuildSameKind(form, result);
};

const rewriteExpr = (expr: Expr): Expr => {
  if (!isForm(expr)) return expr;

  const rewrittenChildren = expr.toArray().map(rewriteExpr);
  const rebuilt = rebuildSameKind(expr, rewrittenChildren);
  const mergedClauseValues = canMergeClauseObjectLiteralValues(rebuilt)
    ? mergeClauseObjectLiterals(rebuilt)
    : rebuilt;

  if (!isCallLikeForm(mergedClauseValues)) {
    return mergedClauseValues;
  }

  // 1) `foo (block (: ...) (: ...))` => `foo (: ...) (: ...)`
  const withSplicedTrailingSuite = spliceTrailingClauseSuiteBlock(
    mergedClauseValues,
  );

  // 2) In suite containers, `foo\n  (: ...)\n  (: ...)` => `foo (: ...) (: ...)`
  const isSuiteContainer =
    withSplicedTrailingSuite.calls("block") || withSplicedTrailingSuite.callsInternal("ast");

  return isSuiteContainer
    ? attachFollowingClauses(withSplicedTrailingSuite)
    : withSplicedTrailingSuite;
};

/**
 * Attaches `:`-clauses to the preceding call-like expression.
 *
 * This runs after `primary`, where `:` has been normalized into `(: label value)`
 * forms, so clause attachment can be expressed as a simple structural rewrite.
 */
export const attachColonClauses: SyntaxMacro = (form: Form): Form =>
  ensureForm(rewriteExpr(form));

const ensureForm = (expr: Expr): Form => (isForm(expr) ? expr : new Form([expr]));
