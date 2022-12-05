import { isList } from "../lib/is-list.mjs";
import { isStringLiteral } from "../lib/is-string.mjs";
import { isWhitespace } from "../lib/is-whitespace.mjs";
import { AST, Expr } from "../parser.mjs";
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

    if (typeof next === "string" && isWhitespace(next)) {
      ast.shift();
      continue;
    }

    if (isList(next)) {
      transformed.push(handleArray(next, indentLevel));
      ast.shift();
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

const handleArray = (ast: AST, indentLevel: number): Expr => {
  const transformed: AST = [];

  let currentExpr: AST = [];
  while (ast.length) {
    const next = ast.shift()!;

    if (next === ",") {
      transformed.push(elideParens(currentExpr) as AST);
      currentExpr = [];
      continue;
    }

    currentExpr.push(next);
  }

  consumeLeadingWhitespace(currentExpr);
  if (currentExpr.length) {
    transformed.push(elideParens(currentExpr, { indentLevel }) as AST);
  }

  if (transformed.length === 1 && isList(transformed[0])) {
    return transformed[0];
  }

  return transformed;
};

const nextExprIndentLevel = (ast: AST) => {
  let index = 0;
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
