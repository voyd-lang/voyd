import { AST } from "./parser";

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

const removeWhitespace = (ast: string | AST) => {
  if (typeof ast === "string") return ast;

  const transformed: AST = [];

  for (const expr of ast) {
    if (expr === " " || expr === "\t" || expr === "\n") {
      continue;
    }

    if (expr instanceof Array) {
      transformed.push(removeWhitespace(expr));
    }

    transformed.push(expr);
  }

  return transformed;
};

export const macros = [parentheticalElision];
