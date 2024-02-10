import { List } from "../../syntax-objects/index.mjs";
import { isInfixOp } from "./infix.mjs";

export const functionalNotation = (list: List): List =>
  list.reduce((expr, index, array) => {
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
