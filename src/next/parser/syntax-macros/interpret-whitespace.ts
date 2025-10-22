import { Form, FormInitElements } from "../ast/form.js";
import {
  Expr,
  IdentifierAtom,
  idIs,
  is,
  WhitespaceAtom,
} from "../ast/index.js";
import { isContinuationOp, isGreedyOp } from "../grammar.js";

// TODO: Update top location by between first child and end child (to replace dynamicLocation)
// TODO: We may need to use FastShiftArray if this is too slow.
export const interpretWhitespace = (form: Form, indentLevel?: number): Form => {
  const processing = form.toArray();
  const transformed: Expr[] = [];

  let hadComma = false;
  while (processing.length) {
    const child = elideParens(processing, indentLevel);
    if (is(child, Form) && !child.length) continue;
    addSibling(child, transformed, hadComma);
    hadComma = nextIsComma(processing);
  }

  const newForm = new Form({ location: form.location, elements: transformed });
  return newForm.length === 1 && is(newForm.first, Form)
    ? newForm.first
    : newForm;
};

const elideParens = (list: Expr[], startIndentLevel?: number): Expr => {
  const transformed: FormInitElements = [];
  const indentLevel = startIndentLevel ?? nextExprIndentLevel(list);

  const pushChildBlock = () => {
    const children: Expr[] = [];

    while (nextExprIndentLevel(list) > indentLevel) {
      const child = elideParens(list, indentLevel + 1);

      // Handle lines that start with an infix op
      if (
        children.length === 1 &&
        is(child, Form) &&
        isContinuationOp(child.first)
      ) {
        const ca = child.toArray();
        transformed.push(ca.shift()!);
        if (child.length === 1) transformed.push(ca.shift()!);
        else transformed.push(child);
        return;
      }

      addSibling(child, children);
    }

    // Handle labeled arguments
    const firstChild = children.at(1);
    if (is(firstChild, Form) && isNamedArg(firstChild)) {
      transformed.push(...children.slice(1));
      return;
    }

    transformed.push(children);
  };

  consumeLeadingWhitespace(list);
  while (list.length) {
    const next = list.at(0);
    const nextIndent = nextExprIndentLevel(list);

    if (isNewline(next) && nextIndent > indentLevel) {
      pushChildBlock();
      continue;
    }

    if (isNewline(next) && !isContinuationOp(transformed.at(-1))) {
      break;
    }

    if (is(next, WhitespaceAtom)) {
      list.shift();
      continue;
    }

    if (idIs(next, ",")) {
      break;
    }

    if (is(next, Form)) {
      list.shift();
      transformed.push(interpretWhitespace(next, indentLevel));
      continue;
    }

    if (isGreedyOp(next)) {
      transformed.push(next);
      list.shift();

      if (nextExprIndentLevel(list) <= indentLevel) {
        transformed.push(elideParens(list, indentLevel));
      }

      continue;
    }

    if (next !== undefined) {
      transformed.push(next);
      list.shift();
      continue;
    }
  }

  const newForm = new Form(transformed);
  return newForm.length === 1 ? newForm.first! : newForm;
};

/**
 * Returns the indentation level of the next expression. Returns `0` if a comma
 * is encountered, which is a performance hack for whitespace block parsing.
 */
const nextExprIndentLevel = (list: Expr[], startIndex = 0) => {
  let nextIndentLevel = 0;
  let i = startIndex;

  for (; i < list.length; i++) {
    const expr = list.at(i)!;
    if (isNewline(expr)) {
      nextIndentLevel = 0;
      continue;
    }

    if (isIndent(expr)) {
      nextIndentLevel += 1;
      continue;
    }

    if (idIs(expr, ",")) return 0;

    break;
  }

  if (i >= list.length) return 0;

  return nextIndentLevel;
};

const consumeLeadingWhitespace = (list: Expr[]) => {
  let next: Expr | undefined;
  while ((next = list.at(0)) && (is(next, WhitespaceAtom) || idIs(next, ","))) {
    list.shift();
  }
};

const isNewline = (v?: Expr) => is(v, WhitespaceAtom) && v.isNewline;
const isIndent = (v: Expr) => is(v, WhitespaceAtom) && v.isIndent;
const nextIsComma = (list: Expr[]) => {
  const next = list.at(0);
  return idIs(next, ",");
};

const isNamedArg = (v: Form) => {
  // Second value should be an identifier whose value is a colon
  if (!idIs(v.first, ":")) {
    return false;
  }

  return true;
};

const addSibling = (child: Expr, siblings: Expr[], hadComma?: boolean) => {
  const olderSibling = siblings.at(-1);

  if (!is(child, Form) || hadComma) {
    siblings.push(child);
    return;
  }

  if (!is(olderSibling, Form) || olderSibling.calls("generics")) {
    siblings.push(child);
    return;
  }

  if (isNamedArg(child) && !isNamedArg(olderSibling)) {
    siblings.pop();
    siblings.push(
      new Form([...olderSibling.toArray(), ...splitNamedArgs(child)])
    );
    return;
  }

  siblings.push(child);
};

const splitNamedArgs = (list: Form): Expr[] => {
  const result: Expr[] = [];
  let start = 0;
  for (let i = 2; i < list.length; i += 1) {
    const expr = list.at(i);
    const next = list.at(i + 1);
    if (is(expr, IdentifierAtom) && idIs(next, ":")) {
      result.push(list.slice(start, i));
      start = i;
    }
  }
  result.push(list.slice(start));
  return result;
};
