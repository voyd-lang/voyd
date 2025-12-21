import {
  Expr,
  Form,
  FormInitElements,
  IdentifierAtom,
  isIdentifierAtom,
} from "../../ast/index.js";
import * as p from "../../ast/predicates.js";
import { isContinuationOp, isOp } from "../../grammar.js";

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
 * Clause-style labeled suite sugar (multiline only).
 *
 * Within a call that has already used an indented-suite labeled arg (the "suite label"),
 * allow subsequent arguments written as:
 *
 *   label <expr>:
 *     <suite>
 *
 * to desugar into:
 *
 *   label: <expr>
 *   <suite_label>:
 *     <suite>
 */
export const expandClauseStyleLabeledSuite = (
  expr: Expr,
  siblings: Expr[]
): Expr[] | undefined => {
  if (!p.isForm(expr)) return undefined;
  if (isNamedArg(expr)) return undefined;

  const first = expr.at(0);
  if (!isIdentifierAtom(first) || isOp(first) || first.isQuoted) {
    return undefined;
  }

  const elements = expr.toArray();
  if (elements.length < 3) return undefined;

  const suiteBlockIndex = (() => {
    for (let i = elements.length - 1; i >= 0; i -= 1) {
      const entry = elements[i];
      if (p.isForm(entry) && (entry as Form).calls("block")) {
        return i;
      }
    }
    return undefined;
  })();

  if (typeof suiteBlockIndex !== "number" || suiteBlockIndex < 2) {
    return undefined;
  }

  const block = elements[suiteBlockIndex] as Form;
  const colon = elements.at(suiteBlockIndex - 1);
  const hasExplicitColon =
    typeof colon !== "undefined" && p.atomEq(colon, ":");

  const previous = siblings.at(-1);
  const suiteLabel = previous ? findTrailingSuiteLabel(previous) : undefined;
  if (!suiteLabel) return undefined;
  if (containsExplicitSuiteLabel(expr, suiteLabel)) {
    return undefined;
  }

  const conditionTokens = elements.slice(
    1,
    suiteBlockIndex - (hasExplicitColon ? 1 : 0)
  );
  if (conditionTokens.length === 0) return undefined;

  const conditionExpr =
    conditionTokens.length === 1
      ? conditionTokens[0]!
      : new Form(conditionTokens);

  const syntheticColon = new IdentifierAtom({
    location: first.location?.clone(),
    value: ":",
  });

  const suiteColon =
    hasExplicitColon && isIdentifierAtom(colon)
      ? colon.clone()
      : new IdentifierAtom({ location: first.location?.clone(), value: ":" });

  const clauseArg = new Form({
    location: first.location?.clone(),
    elements: [first.clone(), syntheticColon, conditionExpr],
  });

  const suiteArg = new Form({
    location: suiteLabel.location?.clone(),
    elements: [suiteLabel.clone(), suiteColon, block],
  });

  const trailing = elements.slice(suiteBlockIndex + 1);
  return [clauseArg, suiteArg, ...trailing];
};

const containsExplicitSuiteLabel = (
  expr: Form,
  suiteLabel: IdentifierAtom
): boolean => {
  const elements = expr.toArray();
  for (let i = 0; i < elements.length - 2; i += 1) {
    const label = elements[i];
    const maybeColon = elements[i + 1];
    const value = elements[i + 2];
    if (
      isIdentifierAtom(label) &&
      !label.isQuoted &&
      label.value === suiteLabel.value &&
      p.atomEq(maybeColon, ":") &&
      p.isForm(value) &&
      (value as Form).calls("block")
    ) {
      return true;
    }
  }
  return false;
};

const findTrailingSuiteLabel = (expr: Expr): IdentifierAtom | undefined => {
  if (!p.isForm(expr)) return undefined;

  const elements = expr.toArray();

  let lastSuiteLabel: IdentifierAtom | undefined;

  // Named-arg form: label: block(...)
  elements.forEach((entry) => {
    if (!p.isForm(entry) || !isNamedArg(entry)) return;
    const label = entry.at(0);
    const value = entry.at(2);
    if (
      isIdentifierAtom(label) &&
      p.isForm(value) &&
      (value as Form).calls("block")
    ) {
      lastSuiteLabel = label;
    }
  });

  // Inline form: label : block(...)
  for (let i = 0; i < elements.length - 2; i += 1) {
    const label = elements[i];
    const maybeColon = elements[i + 1];
    const value = elements[i + 2];
    if (
      isIdentifierAtom(label) &&
      p.atomEq(maybeColon, ":") &&
      p.isForm(value) &&
      (value as Form).calls("block")
    ) {
      lastSuiteLabel = label;
    }
  }

  return lastSuiteLabel;
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
