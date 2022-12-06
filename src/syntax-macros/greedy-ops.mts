import { AST, Expr } from "../parser.mjs";

export const greedyOps = new Set(["=>", "=", "<|", ";"]);
export const isGreedyOp = (expr: Expr): expr is string => {
  if (typeof expr !== "string") return false;
  return greedyOps.has(expr);
};

export const processGreedyOps = (ast: AST) => {
  const transformed: AST = [];
  while (ast.length) {
    const next = ast.shift()!;
    if (next instanceof Array) {
      transformed.push(processGreedyOps(next));
      continue;
    }
    if (isGreedyOp(next)) {
      transformed.push(next);
      const consumed = processGreedyOps(ast);
      transformed.push(consumed);
      continue;
    }
    transformed.push(next);
  }
  return transformed;
};
