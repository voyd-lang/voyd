import { isList } from "../lib/is-list.mjs";
import { removeWhitespace } from "../lib/remove-whitespace.mjs";
import { AST, Expr } from "../parser.mjs";
import { infixOperators } from "./infix.mjs";

export const parentheticalElision = (ast: AST): AST => {
  const transformed: AST = [];

  while (ast.length) {
    consumeLeadingWhitespace(ast);
    transformed.push(elideParens(ast));
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
    const inInfixOp =
      infixOperators.has(ast[0] as string) ||
      infixOperators.has(transformed[transformed.length - 1] as string);
    if (inInfixOp) return;
    push(elideParens(ast, { indentLevel }));
  };

  while (ast.length) {
    const next = ast[0];

    if (next === "\n" && nextLineHasChildExpr()) {
      consumeChildExpr();
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
