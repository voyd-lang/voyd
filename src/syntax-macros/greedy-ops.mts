import { AST, Expr } from "../parser.mjs";

export const greedyOps = new Set(["=>", "=", "<|"]);

export const processGreedyOps = (ast: AST) => {
  const transformed: AST = [];
  while (ast.length) {
    const next = ast.shift()!;
    if (next instanceof Array) {
      transformed.push(processGreedyOps(next));
      continue;
    }
    if (typeof next === "string" && greedyOps.has(next)) {
      transformed.push(processGreedyOps(ast));
      continue;
    }
    transformed.push(next);
  }
  return transformed;
};
