import { Expr, Identifier, List } from "../../lib/syntax/index.mjs";

export const greedyOps = new Set(["=>", "=", "<|", ";"]);
export const isGreedyOp = (expr?: Expr): expr is Identifier => {
  if (!expr?.isIdentifier()) return false;
  return !expr.isQuoted && greedyOps.has(expr.value);
};

export const processGreedyOps = (list: List) => {
  const transformed = new List({ ...list.context });
  while (list.hasChildren) {
    const next = list.consume();

    if (next.isList()) {
      transformed.push(processGreedyOps(next));
      continue;
    }

    if (isGreedyOp(next)) {
      transformed.push(next);
      const consumed = processGreedyOps(list);
      consumed.insert("block", 0);
      transformed.push(consumed);
      continue;
    }

    transformed.push(next);
  }
  return transformed;
};
