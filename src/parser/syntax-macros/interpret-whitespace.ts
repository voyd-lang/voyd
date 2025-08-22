import { idIs, isContinuationOp, isGreedyOp } from "../grammar.js";
import { Expr, List } from "../../syntax-objects/index.js";

export const interpretWhitespace = (list: List, indentLevel?: number): List => {
  const transformed = new List({ ...list.metadata, dynamicLocation: true });

  let hadComma = false;
  while (list.hasChildren) {
    const child = elideParens(list, indentLevel);
    if (child?.isList() && child.length === 0) continue;
    addSibling(child, transformed, hadComma);
    hadComma = nextIsComma(list);
  }

  return transformed.length === 1 && transformed.first()?.isList()
    ? (transformed.first() as List)
    : transformed;
};

const elideParens = (list: Expr, startIndentLevel?: number): Expr => {
  if (!list.isList()) return list;
  const transformed = new List({ dynamicLocation: true });
  const indentLevel = startIndentLevel ?? nextExprIndentLevel(list);

  const pushChildBlock = () => {
    const children = new List({ value: ["block"], dynamicLocation: true });

    while (nextExprIndentLevel(list) > indentLevel) {
      const child = elideParens(list, indentLevel + 1);

      if (
        children.length === 1 &&
        child.isList() &&
        isContinuationOp(child.first())
      ) {
        transformed.push(child.consume());
        if (child.length === 1) transformed.push(child.consume());
        else transformed.push(child);
        return;
      }

      addSibling(child, children);
    }

    // Handle labeled arguments
    const firstChild = children.at(1);
    if (firstChild?.isList() && isNamedArg(firstChild)) {
      transformed.push(...children.argsArray());
      return;
    }

    transformed.push(children);
  };

  consumeLeadingWhitespace(list);
  while (list.hasChildren) {
    const next = list.first();
    const nextIndent = nextExprIndentLevel(list);

    if (isNewline(next) && nextIndent > indentLevel) {
      pushChildBlock();
      continue;
    }

    if (isNewline(next) && !isContinuationOp(transformed.at(-1))) {
      break;
    }

    if (next?.isWhitespace()) {
      list.consume();
      continue;
    }

    if (idIs(next, ",")) {
      break;
    }

    if (next?.isList()) {
      list.consume();
      transformed.push(interpretWhitespace(next, indentLevel));
      continue;
    }

    if (isGreedyOp(next)) {
      transformed.push(list.consume());

      if (nextExprIndentLevel(list) <= indentLevel) {
        transformed.push(elideParens(list, indentLevel));
      }

      continue;
    }

    if (next !== undefined) {
      transformed.push(next);
      list.consume();
      continue;
    }
  }

  return transformed.length === 1 ? transformed.first()! : transformed;
};

/**
 * Returns the indentation level of the next expression. Returns `0` if a comma
 * is encountered, which is a performance hack for whitespace block parsing.
 */
const nextExprIndentLevel = (list: List, startIndex = 0) => {
  let nextIndentLevel = 0;

  for (let i = startIndex; i < list.length; i++) {
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

  return nextIndentLevel;
};

const consumeLeadingWhitespace = (list: List) => {
  let next: Expr | undefined;
  while ((next = list.first()) && (next.isWhitespace() || idIs(next, ","))) {
    list.consume();
  }
};

const isNewline = (v?: Expr) => v?.isWhitespace() && v.isNewline;
const isIndent = (v: Expr) => v.isWhitespace() && v.isIndent;
const nextIsComma = (list: List) => {
  const next = list.first();
  return !!(next?.isIdentifier() && next.is(","));
};

const isNamedArg = (v: List) => {
  const colon = v.at(1);

  // Second value should be an identifier whose value is a colon
  if (!(colon?.isIdentifier() && colon.is(":"))) {
    return false;
  }

  return true;
};

const addSibling = (child: Expr, siblings: List, hadComma?: boolean) => {
  const olderSibling = siblings.at(-1);

  if (!child.isList() || hadComma) {
    siblings.push(child);
    return;
  }

  if (!olderSibling?.isList() || olderSibling.calls("generics")) {
    siblings.push(child);
    return;
  }

  if (isNamedArg(child) && !isNamedArg(olderSibling)) {
    olderSibling.push(...splitNamedArgs(child));
    return;
  }

  siblings.push(child);
};

const splitNamedArgs = (list: List): List[] => {
  const result: List[] = [];
  let start = 0;
  for (let i = 2; i < list.length; i += 1) {
    const expr = list.at(i);
    const next = list.at(i + 1);
    if (expr?.isIdentifier() && next?.isIdentifier() && next.is(":")) {
      result.push(list.slice(start, i));
      start = i;
    }
  }
  result.push(list.slice(start));
  return result;
};
