import {
  isList,
  isWhitespace,
  List,
  Whitespace,
} from "../lib/syntax/syntax.mjs";

export const functionalNotation = (list: List): List =>
  list.reduce((expr, index, array) => {
    if (isList(expr)) return functionalNotation(expr);
    if (isWhitespace(expr)) return expr;

    if (isList(array[index + 1])) {
      const next = new List({
        value: [
          expr,
          new Whitespace({ value: " " }),
          ...array.splice(index + 1, 1),
        ].flat(),
        parent: list,
      });
      return functionalNotation(next);
    }

    return expr;
  });
