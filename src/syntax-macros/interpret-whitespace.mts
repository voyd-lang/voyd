import { Expr, List } from "../lib/syntax/index.mjs";
import { isContinuationOp } from "./infix.mjs";

export const interpretWhitespace = (list: List): List => {
  const transformed = new List({ ...list.context });

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

  const consumeChildExpr = () => {
    const child = new List({ value: ["block"] });
    while (nextExprIndentLevel(list) > indentLevel) {
      child.push(elideParens(list, { indentLevel: indentLevel + 1 }));
    }
    transformed.push(child);
  };

  consumeLeadingWhitespace(list);
  while (list.hasChildren) {
    const next = list.first();

    const isNewline = next?.isWhitespace() && next.isNewline;
    if (isNewline && nextLineHasChildExpr()) {
      consumeChildExpr();
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
