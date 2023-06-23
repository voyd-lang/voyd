import { List, Whitespace } from "../lib/syntax/index.mjs";

export const functionalNotation = (list: List): List =>
  list.reduce((expr, index, array) => {
    if (expr.isList()) return functionalNotation(expr);
    if (expr.isWhitespace()) return expr;

    const nextExpr = array[index + 1];
    if (nextExpr.isList()) {
      const list = array.splice(index + 1, 1)[0] as List;
      list.insert(new Whitespace({ value: " " }));
      list.insert(expr);
      return functionalNotation(list);
    }

    return expr;
  });
