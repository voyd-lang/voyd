import { CallForm, Form, FormInitElements } from "../ast/form.js";
import {
  call,
  Expr,
  FormCursor,
  IdentifierAtom,
  isCallForm,
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
    return hoistFnBlock(normalized);
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
    addSibling(child, transformed);
  }

  const newForm = new Form(transformed);
  const normalizedForm =
    newForm.length === 1 && p.isForm(newForm.first) ? newForm.first : newForm;

  const preserved =
    form instanceof CallForm ? normalizedForm.toCall() : normalizedForm;

  if (form.location) {
    preserved.setLocation(form.location.clone());
  }

  return hoistFnBlock(preserved).unwrap();
};

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

      addSibling(child, children);
    }

    // Handle labeled arguments
    const firstChild = children.at(1);
    if (p.isForm(firstChild) && isNamedArg(firstChild)) {
      transformed.push(...children.slice(1));
      return;
    }

    transformed.push(new CallForm(children));
  };

  consumeLeadingWhitespace(cursor);
  while (!cursor.done) {
    const next = cursor.peek();
    const nextIndent = nextExprIndentLevel(cursor);

    if (isNewline(next) && nextIndent > indentLevel) {
      pushChildBlock();
      continue;
    }

    if (isNewline(next) && !isContinuationOp(transformed.at(-1))) {
      break;
    }

    if (p.isWhitespaceAtom(next)) {
      cursor.consume();
      continue;
    }

    if (p.isForm(next) && next.callsInternal("paren")) {
      cursor.consume();
      const result = elideParens(next.slice(1).cursor(), indentLevel);
      transformed.push(result);
      continue;
    }

    if (p.isForm(next)) {
      cursor.consume();
      transformed.push(interpretWhitespaceExpr(next, indentLevel));
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

/**
 * Returns the indentation level of the next expression. Returns `0` if a comma
 * is encountered, which is a performance hack for whitespace block parsing.
 */
const nextExprIndentLevel = (cursor: FormCursor) => {
  let nextIndentLevel = 0;
  const probe = cursor.fork();

  while (!probe.done) {
    const expr = probe.consume();
    if (isNewline(expr)) {
      nextIndentLevel = 0;
      continue;
    }

    if (isIndent(expr)) {
      nextIndentLevel += 1;
      continue;
    }

    return nextIndentLevel;
  }

  return 0;
};

const consumeLeadingWhitespace = (cursor: FormCursor) => {
  cursor.consumeWhile((expr) => p.isWhitespaceAtom(expr));
};

const isNewline = (v?: Expr) => p.isWhitespaceAtom(v) && v.isNewline;
const isIndent = (v?: Expr) => p.isWhitespaceAtom(v) && v.isIndent;

const isNamedArg = (v: Form) => {
  // Second value should be an identifier whose value is a colon
  if (!p.atomEq(v.at(1), ":")) {
    return false;
  }

  return true;
};

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

  if (tail.length === 1) {
    transformed.push(tail[0]!);
    return true;
  }

  if (tail.length > 1) {
    transformed.push(tail);
    return true;
  }

  return true;
};

const unwrapSyntheticCall = (expr: Expr): Expr => {
  if (p.isForm(expr)) return expr.unwrap();
  return expr;
};

function hoistFnBlock(expr: Form): Form;
function hoistFnBlock(expr: Expr): Expr;
function hoistFnBlock(expr: Expr): Expr {
  if (!p.isForm(expr)) return expr;

  const elements = expr.toArray().map(hoistFnBlock);
  const cloned = new Form({
    location: expr.location?.clone(),
    elements,
  });
  if (!cloned.calls("fn")) {
    return expr instanceof CallForm ? cloned.toCall() : cloned;
  }

  const last = cloned.at(-1);
  const maybeFnBlock = extractTrailingBlock(last);
  if (!maybeFnBlock) {
    return expr instanceof CallForm ? cloned.toCall() : cloned;
  }

  const { remaining, block } = maybeFnBlock;
  const baseElements = cloned.toArray();
  baseElements.pop();
  if (remaining) baseElements.push(remaining);
  baseElements.push(block);

  const hoisted = new Form({
    location: cloned.location?.clone(),
    elements: baseElements,
  });
  return expr instanceof CallForm ? hoisted.toCall() : hoisted;
};

const extractTrailingBlock = (
  expr?: Expr
): { remaining?: Expr; block: Form } | undefined => {
  if (!p.isForm(expr)) return undefined;

  const last = expr.at(-1);
  if (!p.isForm(last) || !last.calls("block")) {
    return undefined;
  }

  const rest = expr.toArray().slice(0, -1);
  const remaining = rest.length ? new Form(rest).unwrap() : undefined;
  return { remaining, block: last };
};

const addSibling = (child: Expr, siblings: Expr[]) => {
  let normalizedChild = unwrapSyntheticCall(child);
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
