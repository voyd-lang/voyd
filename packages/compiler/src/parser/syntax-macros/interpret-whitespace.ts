import { CallForm, Form, FormInitElements } from "../ast/form.js";
import {
  call,
  Expr,
  FormCursor,
  IdentifierAtom,
  isCallForm,
  isIdentifierAtom,
  isForm,
  isWhitespaceAtom,
} from "../ast/index.js";
import * as p from "../ast/predicates.js";
import { isContinuationOp, isGreedyOp, isOp } from "../grammar.js";

export const interpretWhitespace = (form: Form, indentLevel?: number): Form => {
  if (form.callsInternal("ast")) {
    const result = interpretWhitespace(form.slice(1), indentLevel);
    const normalized = call(
      "ast",
      ...(isForm(result.at(0)) ? result.toArray() : [result])
    );
    return finalizeWhitespace(normalized) as Form;
  }

  const functional = applyFunctionalNotation(form);
  const result = interpretWhitespaceExpr(functional, indentLevel);
  return p.isForm(result) ? result : new Form([result]);
};

const interpretWhitespaceExpr = (form: Form, indentLevel?: number): Expr => {
  const cursor = form.cursor();
  const transformed: Expr[] = [];

  while (!cursor.done) {
    const child = elideParens(cursor, indentLevel);
    if (p.isForm(child) && !child.length) continue;
    const expanded = expandClauseStyleLabeledSuite(child, transformed);
    if (expanded) {
      expanded.forEach((entry) => addSibling(entry, transformed));
      continue;
    }

    addSibling(child, transformed);
  }

  const newForm = new Form(transformed);
  const normalizedForm: Form =
    newForm.length === 1 && p.isForm(newForm.first) ? newForm.first : newForm;
  const preserved = normalizeFormKind(form, normalizedForm);
  if (form.location) preserved.setLocation(form.location.clone());

  const normalized = finalizeWhitespace(preserved);
  return p.isForm(normalized) ? normalized.unwrap() : normalized;
};

const finalizeWhitespace = (expr: Expr): Expr =>
  hoistTrailingBlock(attachLabeledClosureSugarHandlers(expr));

const elideParens = (cursor: FormCursor, startIndentLevel?: number): Expr => {
  const transformed: FormInitElements = [];
  const indentLevel = startIndentLevel ?? nextExprIndentLevel(cursor);

  const pushChildBlock = () => {
    const children: Expr[] = [new IdentifierAtom("block")];

    while (nextExprIndentLevel(cursor) > indentLevel) {
      const child = elideParens(cursor, indentLevel + 1);

      if (handleLeadingContinuationOp(child, children, transformed)) {
        return;
      }

      const expanded = expandClauseStyleLabeledSuite(child, children);
      if (expanded) {
        expanded.forEach((entry) => addSibling(entry, children));
        continue;
      }

      addSibling(child, children);
    }

    // Handle labeled arguments
    if (suiteIsArgList(children)) {
      transformed.push(...children.slice(1));
      return;
    }

    transformed.push(new CallForm(children));
  };

  consumeLeadingWhitespace(cursor);
  while (!cursor.done) {
    const next = cursor.peek();

    if (isNewline(next)) {
      const nextIndent = nextExprIndentLevel(cursor);
      if (nextIndent > indentLevel) {
        pushChildBlock();
        continue;
      }

      if (!isContinuationOp(transformed.at(-1))) break;
    }

    if (p.isWhitespaceAtom(next)) {
      cursor.consume();
      continue;
    }

    if (p.isForm(next)) {
      cursor.consume();
      transformed.push(
        next.callsInternal("paren")
          ? elideParens(next.slice(1).cursor(), indentLevel)
          : interpretWhitespaceExpr(next, indentLevel)
      );
      continue;
    }

    if (isGreedyOp(next)) {
      const op = cursor.consume()!;
      transformed.push(op);

      if (nextExprIndentLevel(cursor) <= indentLevel) {
        transformed.push(elideParens(cursor, indentLevel));
      }

      continue;
    }

    const consumed = cursor.consume();
    if (!consumed) break;
    transformed.push(consumed);
  }

  return new Form(transformed).unwrap();
};

type IndentCacheEntry = { position: number; indent: number };
const indentLookaheadCache = new WeakMap<FormCursor, IndentCacheEntry>();

/**
 * Returns the indentation level of the next expression by counting consecutive
 * indent atoms after the most recent newline. Uses a tiny per-cursor cache since
 * callers often query the same position twice.
 */
const nextExprIndentLevel = (cursor: FormCursor) => {
  const cached = indentLookaheadCache.get(cursor);
  if (cached && cached.position === cursor.position) {
    return cached.indent;
  }

  let nextIndentLevel = 0;
  let offset = 0;

  while (true) {
    const expr = cursor.peek(offset);
    if (!expr) {
      nextIndentLevel = 0;
      break;
    }

    if (isNewline(expr)) {
      nextIndentLevel = 0;
      offset += 1;
      continue;
    }

    if (isIndent(expr)) {
      nextIndentLevel += 1;
      offset += 1;
      continue;
    }

    break;
  }

  indentLookaheadCache.set(cursor, {
    position: cursor.position,
    indent: nextIndentLevel,
  });

  return nextIndentLevel;
};

const consumeLeadingWhitespace = (cursor: FormCursor) => {
  cursor.consumeWhile((expr) => p.isWhitespaceAtom(expr));
};

const isNewline = (v?: Expr) => p.isWhitespaceAtom(v) && v.isNewline;
const isIndent = (v?: Expr) => p.isWhitespaceAtom(v) && v.isIndent;

const isNamedArg = (v: Form) => p.atomEq(v.at(1), ":");

const isAssignmentLikeOp = (expr: Expr | undefined): boolean =>
  isIdentifierAtom(expr) && !expr.isQuoted && (expr.value === "=" || expr.value === ":=");

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

const suiteIsArgList = (children: Expr[]): boolean => {
  const entries = children.slice(1).filter((entry) => !isIgnorableSuiteEntry(entry));
  return entries.length > 0 && entries.every(isArgLikeSuiteEntry);
};

/**
 * Clause-style labeled suite sugar (multiline only):
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
 *
 * The suite label is taken from the most recently seen labeled suite argument in the
 * previous call expression (e.g. `then:` or `do:`). Clause sugar is intentionally
 * disallowed on one-liners by requiring the RHS to be an indented `block(...)`.
 */
const expandClauseStyleLabeledSuite = (
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

  const suiteColon = hasExplicitColon && isIdentifierAtom(colon)
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

const handleLeadingContinuationOp = (
  child: Expr,
  children: Expr[],
  transformed: FormInitElements
): boolean => {
  if (
    children.length !== 1 ||
    !p.isForm(child) ||
    !isContinuationOp(child.first)
  ) {
    return false;
  }

  const elements = child.toArray();
  const head = elements.at(0);
  if (head) transformed.push(head);
  const tail = elements.slice(1);
  if (tail.length === 0) return true;
  transformed.push(tail.length === 1 ? tail[0]! : tail);
  return true;
};

const unwrapSyntheticCall = (expr: Expr): Expr => {
  if (p.isForm(expr)) return expr.unwrap();
  return expr;
};

const isCallLikeForm = (form: Form) => {
  const head = form.first;
  if (isIdentifierAtom(head) && isOp(head)) {
    return false;
  }

  return true;
};

const normalizeFormKind = (original: Expr, rebuilt: Form): Expr =>
  original instanceof CallForm ? rebuilt.toCall() : rebuilt;

/** Handles labeled parameter closure sugar syntax my_fn\n  labeled_param_that_takes_closure(param): expression */
const attachLabeledClosureSugarHandlers = (expr: Expr): Expr => {
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

function hoistTrailingBlock(expr: Form): Form;
function hoistTrailingBlock(expr: Expr): Expr;
function hoistTrailingBlock(expr: Expr): Expr {
  if (!p.isForm(expr)) return expr;

  const elements = expr.toArray().map(hoistTrailingBlock);
  const cloned = new Form({
    location: expr.location?.clone(),
    elements,
  });

  if (!isCallLikeForm(cloned)) {
    return normalizeFormKind(expr, cloned);
  }

  const { expr: withoutBlock, block } = splitTrailingBlock(cloned);
  if (!block || !p.isForm(withoutBlock)) {
    return normalizeFormKind(expr, cloned);
  }

  const hoisted = new Form({
    location: cloned.location?.clone(),
    elements: [...withoutBlock.toArray(), block],
  });

  return normalizeFormKind(expr, hoisted);
}

type TrailingBlockExtraction = { expr?: Expr; block?: Form };

const blockBindingOps = new Set(["=>", ":", "="]);

const isBlockBindingOp = (expr?: Expr) =>
  isIdentifierAtom(expr) && blockBindingOps.has(expr.value);

const isNonBindingOp = (expr?: Expr) =>
  isIdentifierAtom(expr) && isOp(expr) && !isBlockBindingOp(expr);

const shouldDescendForTrailingBlock = (
  child: Form,
  previous?: Expr
): boolean => {
  return isNonBindingOp(child.first) || isNonBindingOp(previous);
};

const rebuildSameKind = (original: Form, elements: Expr[]): Expr => {
  const rebuilt = new Form({
    location: original.location?.clone(),
    elements,
  });

  return original instanceof CallForm ? rebuilt.toCall() : rebuilt.unwrap();
};

const splitTrailingBlock = (expr: Expr): TrailingBlockExtraction => {
  if (!p.isForm(expr)) return { expr };

  const elements = expr.toArray();
  const last = elements.at(-1);
  if (!last) return { expr };

  if (p.isForm(last) && last.calls("block")) {
    return {
      expr: rebuildSameKind(expr, elements.slice(0, -1)),
      block: last,
    };
  }

  const previous = elements.at(-2);
  if (p.isForm(last) && shouldDescendForTrailingBlock(last, previous)) {
    const { expr: trimmedLast, block } = splitTrailingBlock(last);
    if (!block) return { expr };

    const remaining = elements.slice(0, -1);
    if (trimmedLast && !(p.isForm(trimmedLast) && trimmedLast.length === 0)) {
      remaining.push(trimmedLast);
    }

    return {
      expr: rebuildSameKind(expr, remaining),
      block,
    };
  }

  return { expr };
};

const addSibling = (child: Expr, siblings: Expr[]) => {
  const normalizedChild = unwrapSyntheticCall(child);
  const olderSibling = siblings.at(-1);

  if (!p.isForm(normalizedChild)) {
    siblings.push(normalizedChild);
    return;
  }

  if (!p.isForm(olderSibling) || olderSibling.callsInternal("generics")) {
    siblings.push(normalizedChild);
    return;
  }

  if (isNamedArg(normalizedChild) && !isNamedArg(olderSibling)) {
    siblings.pop();
    siblings.push(
      new Form([...olderSibling.toArray(), ...splitNamedArgs(normalizedChild)])
    );
    return;
  }

  siblings.push(normalizedChild);
};

const splitNamedArgs = (list: Form): Expr[] => {
  const result: Expr[] = [];
  let start = 0;

  for (let i = 2; i < list.length; i += 1) {
    const expr = list.at(i);
    const next = list.at(i + 1);
    if (p.isIdentifierAtom(expr) && p.atomEq(next, ":")) {
      result.push(list.slice(start, i));
      start = i;
    }
  }

  result.push(list.slice(start));
  return result;
};

/** Converts foo(bar) into (foo bar) */
const applyFunctionalNotation = (form: Form): Form => {
  const cursor = form.cursor();
  const result: Expr[] = [];

  if (isParams(form)) {
    result.push(cursor.consume()!);
  }

  while (!cursor.done) {
    const expr = cursor.consume();
    if (!expr) break;

    if (isForm(expr)) {
      result.push(applyFunctionalNotation(expr));
      continue;
    }

    if (isWhitespaceAtom(expr)) {
      result.push(expr);
      continue;
    }

    const nextExpr = cursor.peek();
    if (isOp(expr) || !isForm(nextExpr)) {
      result.push(expr);
      continue;
    }

    if (nextExpr.callsInternal("generics")) {
      cursor.consume();
      const params = cursor.peek();
      const paramsForm = isParams(params) ? params : undefined;
      if (paramsForm) cursor.consume();
      const normalizedParams = paramsForm
        ? applyFunctionalNotation(paramsForm)
        : undefined;
      const call = new CallForm([
        expr,
        nextExpr,
        ...(normalizedParams ? normalizedParams.rest : []),
      ]);
      result.push(call);
      continue;
    }

    if (isParams(nextExpr)) {
      cursor.consume();
      const normalizedParams = applyFunctionalNotation(nextExpr);
      const call = new CallForm([expr, ...normalizedParams.rest]);
      result.push(call);
      continue;
    }

    result.push(expr);
  }

  const newForm = new Form({
    location: form.location?.clone(),
    elements: result,
  });

  return isCallForm(form) ? newForm.toCall() : newForm;
};

const isParams = (expr: unknown): expr is Form =>
  isForm(expr) && (expr.callsInternal("paren") || expr.callsInternal("tuple"));
