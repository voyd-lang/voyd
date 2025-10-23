import { Form, FormInitElements } from "../ast/form.js";
import {
  Expr,
  FormCursor,
  IdentifierAtom,
  idIs,
  is,
  WhitespaceAtom,
} from "../ast/index.js";
import { isContinuationOp, isGreedyOp } from "../grammar.js";

// TODO: Update top location by between first child and end child (to replace dynamicLocation)
export const interpretWhitespace = (form: Form, indentLevel?: number): Form => {
  const cursor = FormCursor.fromForm(form);
  const transformed: Expr[] = [];

  let hadComma = false;
  while (!cursor.done) {
    const child = elideParens(cursor, indentLevel);
    if (is(child, Form) && !child.length) continue;
    addSibling(child, transformed, hadComma);
    hadComma = nextIsComma(cursor);
  }

  const newForm = new Form({ location: form.location, elements: transformed });
  return newForm.length === 1 && is(newForm.first, Form)
    ? newForm.first
    : newForm;
};

const elideParens = (
  cursor: FormCursor,
  startIndentLevel?: number
): Expr => {
  const transformed: FormInitElements = [];
  const indentLevel = startIndentLevel ?? nextExprIndentLevel(cursor);

  const pushChildBlock = () => {
    const children: Expr[] = [new IdentifierAtom("block")];

    while (nextExprIndentLevel(cursor) > indentLevel) {
      const child = elideParens(cursor, indentLevel + 1);

      // Handle lines that start with an infix op
      if (
        children.length === 1 &&
        is(child, Form) &&
        isContinuationOp(child.first)
      ) {
        const elements = child.toArray();
        const head = elements.at(0);
        if (head) transformed.push(head);
        const tail = elements.slice(1);
        if (tail.length === 1) {
          transformed.push(tail[0]!);
        } else if (tail.length > 1) {
          transformed.push(
            new Form({ elements: tail, location: child.location })
          );
        }
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

    if (is(next, WhitespaceAtom)) {
      cursor.consume();
      continue;
    }

    if (idIs(next, ",")) {
      break;
    }

    if (is(next, Form)) {
      cursor.consume();
      transformed.push(interpretWhitespace(next, indentLevel));
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

  const newForm = new Form(transformed);
  return newForm.length === 1 ? newForm.first! : newForm;
};

/**
 * Returns the indentation level of the next expression. Returns `0` if a comma
 * is encountered, which is a performance hack for whitespace block parsing.
 */
const nextExprIndentLevel = (cursor: FormCursor) => {
  let nextIndentLevel = 0;
  const probe = cursor.fork();
  let exhausted = true;

  while (!probe.done) {
    const expr = probe.consume();
    if (!expr) break;

    if (isNewline(expr)) {
      nextIndentLevel = 0;
      continue;
    }

    if (isIndent(expr)) {
      nextIndentLevel += 1;
      continue;
    }

    if (idIs(expr, ",")) return 0;

    exhausted = false;
    break;
  }

  if (exhausted) return 0;

  return nextIndentLevel;
};

const consumeLeadingWhitespace = (cursor: FormCursor) => {
  cursor.consumeWhile(
    (expr) => !!expr && (is(expr, WhitespaceAtom) || idIs(expr, ","))
  );
};

const isNewline = (v?: Expr) => is(v, WhitespaceAtom) && v.isNewline;
const isIndent = (v?: Expr) => is(v, WhitespaceAtom) && v.isIndent;
const nextIsComma = (cursor: FormCursor) => {
  return idIs(cursor.peek(), ",");
};

const isNamedArg = (v: Form) => {
  // Second value should be an identifier whose value is a colon
  if (!idIs(v.at(1), ":")) {
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
