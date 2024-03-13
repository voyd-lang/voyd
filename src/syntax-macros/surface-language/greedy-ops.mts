import { Expr, Identifier, List } from "../../syntax-objects/index.mjs";

export const greedyOps = new Set(["=>", "=", "<|", ";", "|"]);
export const isGreedyOp = (expr?: Expr): expr is Identifier => {
  if (!expr?.isIdentifier()) return false;
  return !expr.isQuoted && greedyOps.has(expr.value);
};

export const processGreedyOps = (list: List) => {
  const transformed = new List({ ...list.metadata });
  while (list.hasChildren) {
    const next = list.consume();

    if (next.isList()) {
      transformed.push(processGreedyOps(next));
      continue;
    }

    if (isGreedyOp(next)) {
      transformed.push(next);
      const consumed = processGreedyOps(list);
      const result = consumed.value.length === 1 ? consumed.first()! : consumed;
      transformed.push(result);
      continue;
    }

    transformed.push(next);
  }

  return transformed;
};
