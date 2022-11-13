import { AST, Expr } from "./parser";

export type Macro = (ast: AST) => AST;

export type ParentheticalElisionOpts = {
  parentIndentLevel?: number;
};

const parentheticalElision = (
  ast: AST,
  opts: ParentheticalElisionOpts = {}
): AST => {
  const transformed: AST = [];
  let freshLine = false;
  let indentLevel = 0;

  while (ast.length) {
    const expr = ast[0];
    if (expr === "\n") {
      freshLine = true;
      ast.shift();
      continue;
    }

    if (expr === "\t" && freshLine) {
      indentLevel += 1;
      ast.shift();
      continue;
    }

    if (expr === " " || expr === "\t") {
      ast.shift();
      continue;
    }

    if (
      expr &&
      freshLine &&
      (!opts.parentIndentLevel || indentLevel > opts.parentIndentLevel)
    ) {
      ast.shift();
      transformed.push([
        removeWhitespace(expr),
        ...parentheticalElision(ast, { parentIndentLevel: indentLevel }),
      ]);
      continue;
    }

    if (expr && freshLine) {
      break;
    }

    if (expr) {
      ast.shift();
      transformed.push(removeWhitespace(expr));
      continue;
    }
  }

  if (ast.length && typeof opts.parentIndentLevel === "undefined") {
    return [...transformed, parentheticalElision(ast)];
  }

  return transformed;
};

const removeWhitespace = (expr: Expr) => {
  if (typeof expr === "string") return expr;

  const transformed: AST = [];

  for (const exp of expr) {
    if (exp === " " || exp === "\t" || exp === "\n") {
      continue;
    }

    if (exp instanceof Array) {
      transformed.push(removeWhitespace(exp));
    }

    transformed.push(exp);
  }

  return transformed;
};

export const macros = [parentheticalElision];
