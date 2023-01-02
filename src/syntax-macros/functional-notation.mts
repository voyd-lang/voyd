import {
  isList,
  isWhitespace,
  List,
  Whitespace,
} from "../lib/syntax/index.mjs";

export const functionalNotation = (list: List): List =>
  list.reduce((expr, index, array) => {
    if (isList(expr)) return functionalNotation(expr);
    if (isWhitespace(expr)) return expr;

    const nextExpr = array[index + 1];
    if (isList(nextExpr)) {
      const next = new List({
        value: [
          expr,
          new Whitespace({ value: " " }),
          ...array.splice(index + 1, 1),
        ].flat(),
        context: nextExpr,
      });
      return functionalNotation(next);
    }

    return expr;
  });
