import { AST } from "../parser";

export const functionalNotation = (ast: AST): AST => {
  return ast
    .slice(0)
    .map((expr, index, array) => {
      if (expr instanceof Array) return functionalNotation(expr);
      if (/\s/.test(expr)) return expr;
      if (array[index + 1] instanceof Array) {
        const next = [expr, " ", ...array.splice(index + 1, 1)].flat();
        return functionalNotation(next);
      }
      return expr;
    })
    .filter(Boolean);
};
