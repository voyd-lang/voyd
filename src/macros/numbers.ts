import { AST, Expr } from "../parser";

export const numbers = (ast: AST): AST => {
  return ast.map(crawlNumbers);
};

const crawlNumbers = (expr: Expr): Expr => {
  if (expr instanceof Array) {
    return expr.map(crawlNumbers);
  }

  if (isInt(expr)) {
    return ["int", expr];
  }

  if (isFloat(expr)) {
    return ["float", expr];
  }

  return expr;
};

const isInt = (word: string) => /^[0-9]+$/.test(word);
const isFloat = (word: string) => /^[0-9]+\.[0-9]+$/.test(word);
