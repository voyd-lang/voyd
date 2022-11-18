import { removeWhitespace } from "../lib/remove-whitespace.mjs";
import { AST, Expr } from "../parser.mjs";

export type ParentheticalElisionOpts = {
  indentLevel?: number;
};

export const parentheticalElision = (
  ast: AST,
  opts: ParentheticalElisionOpts = {}
): AST => {
  const transformed: AST = [];
  let indentLevel = opts.indentLevel;

  const nextLineHasChildExpr = () => {
    if (typeof indentLevel === "undefined" && ast.length) {
      return true;
    }

    return nextExprIndentLevel(ast) > (indentLevel ?? 0);
  };

  const push = (expr: Expr) => {
    if (expr.length === 0) return;

    if (expr.length === 1 && expr[0] instanceof Array) {
      transformed.push(expr[0]);
      return;
    }

    transformed.push(expr);
  };

  while (ast.length) {
    const next = ast[0];

    if (next === "\n" && nextLineHasChildExpr()) {
      const indentLevel = nextExprIndentLevel(ast);
      consumeLeadingWhitespace(ast);
      push(parentheticalElision(ast, { indentLevel }));
      continue;
    }

    if (next === "\n") {
      break;
    }

    if (next === " " || next === "\t") {
      ast.shift();
      continue;
    }

    if (next) {
      transformed.push(removeWhitespace(next));
      ast.shift();
      continue;
    }
  }

  if (ast.length && typeof indentLevel === "undefined") {
    consumeLeadingWhitespace(ast);
  }

  if (ast.length && typeof indentLevel === "undefined") {
    return [...transformed, parentheticalElision(ast)];
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

const consumeLeadingWhitespace = (ast: AST) => {
  while (ast.length) {
    const next = ast[0];
    if (typeof next === "string" && [" ", "\n", "\t"].includes(next)) {
      ast.shift();
      continue;
    }
    break;
  }
};
