import {
  Expr,
  isList,
  isWhitespace,
  List,
  newLine,
} from "../lib/syntax/index.mjs";
import { isGreedyOp } from "./greedy-ops.mjs";
import { isContinuationOp } from "./infix.mjs";

export const parentheticalElision = (list: List): List => {
  const transformed = new List({ from: list });

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
  if (!isList(list)) return list;
  const transformed = new List({});
  let indentLevel = opts.indentLevel ?? 0;

  const nextLineHasChildExpr = () => nextExprIndentLevel(list) > indentLevel;

  const consumeChildExpr = () => {
    const indentLevel = nextExprIndentLevel(list);
    consumeLeadingWhitespace(list);
    if (hasContinuation(list, transformed)) return;
    transformed.push(elideParens(list, { indentLevel }) as List);
  };

  consumeLeadingWhitespace(list);
  while (list.hasChildren) {
    const next = list.first();

    const isNewline = isWhitespace(next) && next.isNewline;
    if (isNewline && nextLineHasChildExpr()) {
      consumeChildExpr();
      continue;
    }

    if (isNewline && !hasContinuation(list, transformed)) {
      break;
    }

    if (isWhitespace(next)) {
      list.consume();
      continue;
    }

    if (isList(next)) {
      transformed.push(elideListContents(next, indentLevel));
      list.consume();
      continue;
    }

    if (isGreedyOp(next)) {
      assistGreedyOpProcessing(list, transformed, indentLevel);
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

// Consumes preceding expressions as though they belong to the operator at ast[-]
// Modifies ast and transformed parameters
const assistGreedyOpProcessing = (
  list: List,
  transformed: List,
  indentLevel: number
) => {
  transformed.push(list.consume());

  const precedingExprCount = lineExpressionCount(list);
  if (precedingExprCount === 0) {
    transformed.push("block");
    return;
  }

  consumeLeadingWhitespace(list);
  if (precedingExprCount === 1 && isList(list.first())) {
    transformed.push(
      ...elideListContents(list.consume() as List, indentLevel).value
    );
    return;
  }

  if (precedingExprCount === 1 && nextLineIndentLevel(list) <= indentLevel) {
    transformed.push("block");
    return;
  }
};

const nextLineIndentLevel = (list: List) => {
  const index = list.indexOf(newLine());
  if (index === -1) return 0;
  return nextExprIndentLevel(list, index);
};

const lineExpressionCount = (list: List) => {
  let count = 0;
  for (const expr of list.value) {
    if (isWhitespace(expr) && !expr.isNewline) continue;
    if (expr.is("\n")) break;
    count += 1;
  }
  return count;
};

const elideListContents = (list: List, indentLevel: number): List => {
  consumeLeadingWhitespace(list);
  const transformed = new List({
    value: [elideParens(list, { indentLevel })],
    from: list,
  });

  if (transformed.value.length === 1 && isList(transformed.first())) {
    return transformed.first() as List;
  }

  return transformed;
};

const nextExprIndentLevel = (list: List, startIndex?: number) => {
  let index = startIndex ?? 0;
  let nextIndentLevel = 0;

  while (list.at(index)) {
    const expr = list.at(index)!;
    if (expr.is("\n")) {
      nextIndentLevel = 0;
      index += 1;
      continue;
    }

    if (expr.is("\t")) {
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
    if (isWhitespace(expr)) continue;
    return isContinuationOp(expr);
  }

  return false;
};

const consumeLeadingWhitespace = (list: List) => {
  while (list.hasChildren) {
    const next = list.first();
    if (isWhitespace(next)) {
      list.consume();
      continue;
    }
    break;
  }
};
