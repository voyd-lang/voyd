import { isList } from "../lib/is-list.mjs";
import { isWhitespace } from "../lib/is-whitespace.mjs";
import { AST, Expr } from "../parser.mjs";
import { isContinuationOp } from "./infix.mjs";

export const parentheticalElision = (ast: AST): AST => elideParens(ast);

export type ElideParensOpts = {
  indentLevel?: number;
  transformed?: AST;
  isList?: boolean;
};

const elideParens = (ast: AST, opts: ElideParensOpts = {}): AST => {
  const transformed: AST = [];
  let indentLevel = opts.indentLevel ?? 0;

  const nextLineHasChildExpr = () => nextExprIndentLevel(ast) > indentLevel;

  const pushArgs = (...expr: Expr[]) => {
    if (opts.isList) {
      transformed.push(...expr);
      return;
    }

    const fn = transformed.pop();
    if (!fn) {
      transformed.push(...expr);
      return;
    }

    let list = isList(fn) && fn.length ? fn : [fn];
    list.push(...expr);
    transformed.push(list);
  };

  const consumeChildExpr = () => {
    const indentLevel = nextExprIndentLevel(ast);
    consumeLeadingWhitespace(ast);
    if (hasContinuation(ast, transformed)) return;
    pushArgs(...elideParens(ast, { indentLevel }));
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

    // TODO Custom parser here
    if (next instanceof Array) {
      pushArgs(elideParens(next, { indentLevel, isList: true }));
      ast.shift();
      continue;
    }

    if (next !== undefined) {
      pushArgs(next);
      ast.shift();
      continue;
    }
  }

  if (ast.length && indentLevel === 0) {
    return elideParens(ast, {
      transformed: [...(opts.transformed ?? []), ...transformed],
    });
  }

  return [...(opts.transformed ?? []), ...transformed];
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
