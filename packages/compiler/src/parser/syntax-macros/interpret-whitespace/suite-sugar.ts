import {
  Expr,
  Form,
  FormInitElements,
  isIdentifierAtom,
} from "../../ast/index.js";
import * as p from "../../ast/predicates.js";
import { isContinuationOp } from "../../grammar.js";

const isNamedArg = (v: Form) => p.atomEq(v.at(1), ":");

const isAssignmentLikeOp = (expr: Expr | undefined): boolean =>
  isIdentifierAtom(expr) &&
  !expr.isQuoted &&
  (expr.value === "=" || expr.value === ":=");

const isInlineLabeledExpr = (v: Form): boolean => {
  const elements = v.toArray().filter((expr) => !p.isWhitespaceAtom(expr));
  if (elements.length < 3) return false;

  const colonIndex = elements.findIndex(
    (expr, index) => index > 0 && p.atomEq(expr, ":")
  );
  if (colonIndex <= 0 || colonIndex >= elements.length - 1) return false;

  const rhsHead = elements[colonIndex + 1];
  if (p.isForm(rhsHead) && (rhsHead as Form).calls("block")) {
    return false;
  }

  // Reject forms that look like type annotations / assignments such as `let x: T = 1`,
  // by disallowing assignment-like operators on the RHS at the same list level.
  for (let i = colonIndex + 1; i < elements.length; i += 1) {
    if (isAssignmentLikeOp(elements[i])) {
      return false;
    }
  }

  return true;
};

const isIgnorableSuiteEntry = (expr: Expr): boolean =>
  p.isWhitespaceAtom(expr) || p.isCommentAtom(expr);

const isArgLikeSuiteEntry = (expr: Expr): boolean =>
  p.isForm(expr) && (isNamedArg(expr) || isInlineLabeledExpr(expr));

/**
 * Detects when an indented `block(...)` is being used as a labeled-argument list,
 * so it can be spliced into the parent call as individual arguments.
 */
export const suiteIsArgList = (children: Expr[]): boolean => {
  const entries = children.slice(1).filter((entry) => !isIgnorableSuiteEntry(entry));
  return entries.length > 0 && entries.every(isArgLikeSuiteEntry);
};

/**
 * Extracts a leading continuation operator that binds the current indented suite
 * back to the parent expression.
 */
export const extractLeadingContinuationOp = (
  child: Expr,
  children: Expr[]
): FormInitElements | undefined => {
  if (
    children.length !== 1 ||
    !p.isForm(child) ||
    !isContinuationOp(child.first)
  ) {
    return undefined;
  }

  const elements = child.toArray();
  const head = elements.at(0);
  if (!head) return [];
  const tail = elements.slice(1);
  if (tail.length === 0) return [head];
  return [head, tail.length === 1 ? tail[0]! : tail];
};
