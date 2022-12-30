import {
  Expr,
  Identifier,
  isIdentifier,
  isList,
  List,
} from "../lib/syntax.mjs";

export const greedyOps = new Set(["=>", "=", "<|", ";"]);
export const isGreedyOp = (expr: Expr): expr is Identifier => {
  if (!isIdentifier(expr)) return false;
  return greedyOps.has(expr.value);
};

export const processGreedyOps = (list: List) => {
  const transformed = new List({ context: list });
  while (list.hasChildren) {
    const next = list.consume();

    if (isList(next)) {
      transformed.push(processGreedyOps(next));
      continue;
    }

    if (isGreedyOp(next)) {
      transformed.push(next);
      const consumed = processGreedyOps(list);
      transformed.push(consumed);
      continue;
    }

    transformed.push(next);
  }
  return transformed;
};
