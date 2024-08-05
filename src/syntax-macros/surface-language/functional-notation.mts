import { isOp } from "../../lib/grammar.mjs";
import { List } from "../../syntax-objects/index.mjs";

export const functionalNotation = (list: List): List => {
  let isTuple = false;

  const result = list.mapFilter((expr, index, array) => {
    if (expr.isList()) return functionalNotation(expr);
    if (expr.isWhitespace()) return expr;

    const nextExpr = array[index + 1];
    if (nextExpr && nextExpr.isList() && !isOp(expr)) {
      const list = array.splice(index + 1, 1)[0] as List;
      list.insert(expr);
      list.insert(",", 1);
      list.mayBeTuple = false;
      return functionalNotation(list);
    }

    if (list.mayBeTuple && expr.isIdentifier() && expr.is(",")) {
      isTuple = true;
    }

    return expr;
  });

  if (isTuple) {
    result.insert("tuple");
  }

  return result;
};
