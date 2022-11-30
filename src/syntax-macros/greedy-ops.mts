import { AST, Expr } from "../parser.mjs";

export const greedyOps = new Set(["=>", "=", "<|", ";"]);

export const processGreedyOps = (ast: AST) => {
  const transformed: AST = [];
  while (ast.length) {
    const next = ast.shift()!;
    if (next instanceof Array) {
      transformed.push(processGreedyOps(next));
      continue;
    }
    if (typeof next === "string" && greedyOps.has(next)) {
      transformed.push(next);
      const consumed = processGreedyOps(ast);
      transformed.push(["block", ...consumed]);
      continue;
    }
    transformed.push(next);
  }
  return transformed;
};
