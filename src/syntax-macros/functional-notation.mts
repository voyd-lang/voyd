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
      const list = array.splice(index + 1, 1)[0] as List;
      list.insert(new Whitespace({ value: " " }));
      list.insert(expr);
      return functionalNotation(list);
    }

    return expr;
  });
