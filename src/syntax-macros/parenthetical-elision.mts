import { isList } from "../lib/is-list.mjs";
import { isWhitespace } from "../lib/is-whitespace.mjs";
import { AST, Expr } from "../parser.mjs";
import { isGreedyOp } from "./greedy-ops.mjs";
import { isContinuationOp } from "./infix.mjs";

export const parentheticalElision = (ast: AST): AST => {
  const transformed: AST = [];
  while (ast.length) {
    transformed.push(elideParens(ast) as AST);
    consumeLeadingWhitespace(ast);
  }
  return transformed;
};

export type ElideParensOpts = {
  indentLevel?: number;
};

const elideParens = (ast: Expr, opts: ElideParensOpts = {}): Expr => {
  if (!isList(ast)) return ast;
  const transformed: AST = [];
  let indentLevel = opts.indentLevel ?? 0;

  const nextLineHasChildExpr = () => nextExprIndentLevel(ast) > indentLevel;

  const consumeChildExpr = () => {
    const indentLevel = nextExprIndentLevel(ast);
    consumeLeadingWhitespace(ast);
    if (hasContinuation(ast, transformed)) return;
    transformed.push(elideParens(ast, { indentLevel }) as AST);
  };

  consumeLeadingWhitespace(ast);
  while (ast.length) {
    const next = ast[0];

    if (next === "\n" && nextLineHasChildExpr()) {
      consumeChildExpr();
      continue;
    }

    if (next === "\n" && !hasContinuation(ast, transformed)) {
      break;
    }

    if (isWhitespace(next)) {
      ast.shift();
      continue;
    }

    if (isList(next)) {
      transformed.push(elideParens(next, { indentLevel }));
      ast.shift();
      continue;
    }

    if (isGreedyOp(next)) {
      assistGreedyOpProcessing(ast, transformed, indentLevel);
      continue;
    }

    if (next !== undefined) {
      transformed.push(next);
      ast.shift();
      continue;
    }
  }

  if (transformed.length === 1) {
    return transformed[0];
  }

  return transformed;
};

// Modifies transformed, assumes ast[0] is greedy op
const assistGreedyOpProcessing = (
  ast: AST,
  transformed: AST,
  indentLevel: number
) => {
  transformed.push(ast[0] as string);
  ast.shift();

  const precedingExprCount = lineExpressionCount(ast);
  if (precedingExprCount === 0) {
    transformed.push("block");
    return;
  }

  consumeLeadingWhitespace(ast);
  if (precedingExprCount === 1 && isList(ast[0])) {
    transformed.push(...(elideParens(ast[0], { indentLevel }) as AST));
    ast.shift();
    return;
  }

  if (precedingExprCount === 1 && nextLineIndentLevel(ast) <= indentLevel) {
    transformed.push("block");
    return;
  }
};

const nextLineIndentLevel = (ast: AST) => {
  const index = ast.indexOf("\n");
  if (index === -1) return 0;
  return nextExprIndentLevel(ast, index);
};

const lineExpressionCount = (ast: AST) => {
  let count = 0;
  for (const expr of ast) {
    if (isWhitespace(expr) && expr !== "\n") continue;
    if (expr === "\n") break;
    count += 1;
  }
  return count;
};

const nextExprIndentLevel = (ast: AST, startIndex?: number) => {
  let index = startIndex ?? 0;
  let nextIndentLevel = 0;

  while (ast[index]) {
    const expr = ast[index];
    if (expr === "\n") {
      nextIndentLevel = 0;
      index += 1;
      continue;
    }

    if (expr === "\t") {
      nextIndentLevel += 1;
      index += 1;
      continue;
    }

    break;
  }

  return nextIndentLevel;
};

const hasContinuation = (ast: AST, transformed: AST) => {
  const lastTransformedExpr = transformed[transformed.length - 1] as string;
  if (isContinuationOp(lastTransformedExpr)) {
    return true;
  }

  for (const expr of ast) {
    if (typeof expr !== "string") return false;
    if (isWhitespace(expr)) continue;
    return isContinuationOp(expr);
  }

  return false;
};

const consumeLeadingWhitespace = (ast: AST) => {
  while (ast.length) {
    const next = ast[0];
    if (typeof next === "string" && isWhitespace(next)) {
      ast.shift();
      continue;
    }
    break;
  }
};
