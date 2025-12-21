import { Expr, Form } from "../../ast/index.js";
import * as p from "../../ast/predicates.js";
import { isCallLikeForm, normalizeFormKind } from "./shared.js";

const hasTrailingHandlerBlock = (v: Form): boolean => {
  if (v.length < 3) return false;
  const last = v.at(v.length - 1);
  const colon = v.at(v.length - 2);
  const target = v.at(v.length - 3);
  return (
    p.atomEq(colon, ":") &&
    p.isForm(last) &&
    (last as Form).calls("block") &&
    p.isForm(target) &&
    isCallLikeForm(target)
  );
};

const isHandlerClause = (v: Expr | undefined): v is Form =>
  p.isForm(v) &&
  ((v.calls(":") &&
    p.isForm(v.at(1)) &&
    p.isForm(v.at(2)) &&
    (v.at(2) as Form).calls("block")) ||
    hasTrailingHandlerBlock(v));

/**
 * Handles labeled parameter closure sugar.
 *
 * Syntax: `my_fn\n  labeled_param_that_takes_closure(param): expression`
 */
export const attachLabeledClosureSugarHandlers = (expr: Expr): Expr => {
  if (!p.isForm(expr)) return expr;

  const rewritten = expr.toArray().map(attachLabeledClosureSugarHandlers);
  const elements = expr.calls("block")
    ? mergeHandlerClauses(rewritten)
    : rewritten;

  return normalizeFormKind(
    expr,
    new Form({
      location: expr.location?.clone(),
      elements,
    })
  );
};

const mergeHandlerClauses = (entries: Expr[]): Expr[] => {
  const result: Expr[] = [];

  entries.forEach((entry) => {
    const previous = result.at(-1);

    if (
      isHandlerClause(entry) &&
      p.isForm(previous) &&
      isCallLikeForm(previous)
    ) {
      result.pop();
      result.push(new Form([...previous.toArray(), entry]));
      return;
    }

    result.push(entry);
  });

  return result;
};
