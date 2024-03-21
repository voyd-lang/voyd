import { isInfixOp } from "../../lib/grammar.mjs";
import { List } from "../../syntax-objects/index.mjs";

export const functionalNotation = (list: List): List =>
  list.mapFilter((expr, index, array) => {
    if (expr.isList()) return functionalNotation(expr);
    if (expr.isWhitespace()) return expr;

    const nextExpr = array[index + 1];
    if (nextExpr && nextExpr.isList() && !isInfixOp(expr)) {
      const list = array.splice(index + 1, 1)[0] as List;
      list.insert(expr);
      return functionalNotation(list);
    }

    return expr;
  });
