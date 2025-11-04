import { CallForm, Form, FormInitElements } from "../ast/form.js";
import {
  atomEq,
  Expr,
  FormCursor,
  IdentifierAtom,
  isBoolAtom,
  isCallForm,
  isFloatAtom,
  isForm,
  isIdentifierAtom,
  isIntAtom,
  isStringAtom,
  isWhitespaceAtom,
} from "../ast/index.js";
import { isContinuationOp, isGreedyOp } from "../grammar.js";

export const interpretWhitespace = (form: Form, indentLevel?: number): Form => {
  const cursor = form.cursor();
  const transformed: Expr[] = [];

  while (!cursor.done) {
    const child = elideParens(cursor, indentLevel);
    if (isForm(child) && !child.length) continue;
    addSibling(child, transformed);
  }

  const newForm = new Form(transformed);
  return newForm.length === 1 && isForm(newForm.first)
    ? newForm.first
    : newForm;
};

const elideParens = (
  cursor: FormCursor,
  startIndentLevel?: number
): CallForm => {
  const transformed: FormInitElements = [];
  const indentLevel = startIndentLevel ?? nextExprIndentLevel(cursor);

  const pushChildBlock = () => {
    const children: Expr[] = [new IdentifierAtom("block")];

    while (nextExprIndentLevel(cursor) > indentLevel) {
      const child = elideParens(cursor, indentLevel + 1).unwrap();

      if (handleLeadingContinuationOp(child, children, transformed)) {
        return;
      }

      addSibling(child, children);
    }

    // Handle labeled arguments
    const firstChild = children.at(1);
    if (isForm(firstChild) && isNamedArg(firstChild)) {
      transformed.push(...children.slice(1));
      return;
    }

    transformed.push(children);
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

    if (isWhitespaceAtom(next)) {
      cursor.consume();
      continue;
    }

    if (atomEq(next, ",")) {
      break;
    }

    if (isForm(next) && next.callsInternal("paren")) {
      cursor.consume();
      const result = elideParens(next.slice(1).cursor(), indentLevel);
      transformed.push(unwrapNonCalls(next, result));
      continue;
    }

    if (isForm(next)) {
      cursor.consume();
      const result = interpretWhitespace(next, indentLevel);
      transformed.push(unwrapNonCalls(next, result));
      continue;
    }

    if (isGreedyOp(next)) {
      const op = cursor.consume()!;
      transformed.push(op);

      if (nextExprIndentLevel(cursor) <= indentLevel) {
        transformed.push(elideParens(cursor, indentLevel).unwrap());
      }

      continue;
    }

    const consumed = cursor.consume();
    if (!consumed) break;
    transformed.push(consumed);
  }

  return new CallForm(transformed);
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
  cursor.consumeWhile((expr) => isWhitespaceAtom(expr));
};

const isNewline = (v?: Expr) => isWhitespaceAtom(v) && v.isNewline;
const isIndent = (v?: Expr) => isWhitespaceAtom(v) && v.isIndent;

const isNamedArg = (v: Form) => {
  // Second value should be an identifier whose value is a colon
  if (!atomEq(v.at(1), ":")) {
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
    !isForm(child) ||
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
  let current = expr;

  while (isCallForm(current) && current.length === 1) {
    const first = current.first;
    if (!first) break;

    if (isForm(first)) {
      current = first;
      continue;
    }

    if (
      isBoolAtom(first) ||
      isIntAtom(first) ||
      isFloatAtom(first) ||
      isStringAtom(first)
    ) {
      return first;
    }

    break;
  }

  return current;
};

const addSibling = (child: Expr, siblings: Expr[]) => {
  const normalizedChild = unwrapSyntheticCall(child);
  const olderSibling = siblings.at(-1);

  if (!isForm(normalizedChild)) {
    siblings.push(normalizedChild);
    return;
  }

  if (!isForm(olderSibling) || olderSibling.callsInternal("generics")) {
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
    if (isIdentifierAtom(expr) && atomEq(next, ":")) {
      result.push(list.slice(start, i));
      start = i;
    }
  }

  result.push(list.slice(start));
  return result;
};

const unwrapNonCalls = (source: unknown, transformed: Expr): Expr =>
  !isCallForm(source) && isForm(transformed) && !isCallForm(transformed)
    ? transformed.unwrap()
    : transformed;
