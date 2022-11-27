import { isList } from "../lib/is-list.mjs";
import { isWhitespace } from "../lib/is-whitespace.mjs";
import { removeWhitespace } from "../lib/remove-whitespace.mjs";
import { AST, Expr } from "../parser.mjs";
import { infixOperators } from "./infix.mjs";

export const parentheticalElision = (ast: AST): AST => {
  const transformed: AST = [];

  while (ast.length) {
    consumeLeadingWhitespace(ast);
    const elided = elideParens(ast);
    if (elided instanceof Array && elided.length === 0) continue;
    transformed.push(elided);
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

  const push = (expr: Expr) => {
    if (isList(expr) && expr.length === 0) return;
    transformed.push(expr);
  };

  const consumeChildExpr = () => {
    const indentLevel = nextExprIndentLevel(ast);
    consumeLeadingWhitespace(ast);
    if (hasContinuation(ast, transformed)) return;
    push(elideParens(ast, { indentLevel }));
  };

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

    if (next instanceof Array) {
      push(elideParens(next, { indentLevel }));
      ast.shift();
      continue;
    }

    // TODO: Support elision within lists
    if (next || ast.length) {
      transformed.push(removeWhitespace(next));
      ast.shift();
      continue;
    }
  }

  return transformed.length === 1 ? transformed[0] : transformed;
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
  if (infixOperators.has(transformed[transformed.length - 1] as string)) {
    return true;
  }

  for (const expr of ast) {
    if (typeof expr !== "string") return false;
    if (isWhitespace(expr)) continue;
    return infixOperators.has(expr);
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
