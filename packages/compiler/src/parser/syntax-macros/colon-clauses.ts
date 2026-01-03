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

const rebuildSameKind = (original: Form, elements: Expr[]): Form => {
  const rebuilt = new Form({
    location: original.location?.clone(),
    elements,
  });
  return original instanceof CallForm ? rebuilt.toCall() : rebuilt;
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
    const current = elements[index]!;

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

  if (!isCallLikeForm(rebuilt)) {
    return rebuilt;
  }

  // 1) `foo (block (: ...) (: ...))` => `foo (: ...) (: ...)`
  const withSplicedTrailingSuite = spliceTrailingClauseSuiteBlock(rebuilt);

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
