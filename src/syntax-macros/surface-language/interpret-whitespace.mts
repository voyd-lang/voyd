import { Expr, List } from "../../syntax-objects/index.mjs";
import { isContinuationOp } from "./infix.mjs";

export const interpretWhitespace = (list: List): List => {
  const transformed = new List({ ...list.metadata });

  while (list.hasChildren) {
    transformed.push(elideParens(list) as List);
    consumeLeadingWhitespace(list);
  }

  return transformed;
};

export type ElideParensOpts = {
  indentLevel?: number;
};

const elideParens = (list: Expr, opts: ElideParensOpts = {}): Expr => {
  if (!list.isList()) return list;
  const transformed = new List({});
  let indentLevel = opts.indentLevel ?? 0;

  const nextLineHasChildExpr = () => nextExprIndentLevel(list) > indentLevel;

  const consumeChildren = () => {
    const children = new List({});

    while (nextExprIndentLevel(list) > indentLevel) {
      const child = elideParens(list, { indentLevel: indentLevel + 1 });

      const olderSibling = children.at(-1);
      if (
        isNamedParameter(child) &&
        olderSibling?.isList() &&
        !isNamedParameter(olderSibling)
      ) {
        olderSibling.push(child);
        continue;
      }

      children.push(child);
    }

    return children;
  };

  const pushChildren = (child: List) => {
    if (isListOfNamedParameters(child)) {
      transformed.push(...child.value);
      return;
    }

    transformed.push(["block", ...child.value]);
    return;
  };

  consumeLeadingWhitespace(list);
  while (list.hasChildren) {
    const next = list.first();

    const isNewline = next?.isWhitespace() && next.isNewline;
    if (isNewline && nextLineHasChildExpr()) {
      const child = consumeChildren();
      pushChildren(child);
      continue;
    }

    if (isNewline && !hasContinuation(list, transformed)) {
      break;
    }

    if (next?.isWhitespace()) {
      list.consume();
      continue;
    }

    if (next?.isList()) {
      transformed.push(removeWhitespaceFromList(next, indentLevel));
      list.consume();
      continue;
    }

    if (next !== undefined) {
      transformed.push(next);
      list.consume();
      continue;
    }
  }

  if (transformed.value.length === 1) {
    return transformed.first()!;
  }

  return transformed;
};

const removeWhitespaceFromList = (list: List, indentLevel: number): List => {
  consumeLeadingWhitespace(list);
  return list
    .map((expr) => {
      if (expr.isList()) {
        return removeWhitespaceFromList(expr, indentLevel);
      }

      return expr;
    })
    .filter((expr) => {
      if (expr.isWhitespace()) return false;
      return true;
    });
};

const nextExprIndentLevel = (list: List, startIndex?: number) => {
  let index = startIndex ?? 0;
  let nextIndentLevel = 0;

  while (list.at(index)) {
    const expr = list.at(index)!;
    if (isNewline(expr)) {
      nextIndentLevel = 0;
      index += 1;
      continue;
    }

    if (isTab(expr)) {
      nextIndentLevel += 1;
      index += 1;
      continue;
    }

    break;
  }

  return nextIndentLevel;
};

const hasContinuation = (list: List, transformed: List) => {
  const lastTransformedExpr = transformed.at(-1);
  if (isContinuationOp(lastTransformedExpr)) {
    return true;
  }

  for (const expr of list.value) {
    if (expr.isWhitespace()) continue;
    return isContinuationOp(expr);
  }

  return false;
};

const consumeLeadingWhitespace = (list: List) => {
  while (list.hasChildren) {
    const next = list.first();
    if (next?.isWhitespace()) {
      list.consume();
      continue;
    }
    break;
  }
};

const isNewline = (v: Expr) => v.isWhitespace() && v.isNewline;
const isTab = (v: Expr) => v.isWhitespace() && v.isTab;

const isListOfNamedParameters = (v: Expr) => {
  return v.isList() && v.value.every((v) => isNamedParameter(v));
};

const isNamedParameter = (v: Expr) => {
  if (!v.isList()) return false;

  const identifier = v.at(0);
  const colon = v.at(1);

  // First value should be an identifier
  if (!identifier?.isIdentifier()) {
    return false;
  }

  // Second value should be an identifier whose value is a colon
  if (!(colon?.isIdentifier() && colon.is(":"))) {
    return false;
  }

  return true;
};
