import { isOp } from "../../lib/grammar.js";
import { Expr, List } from "../../syntax-objects/index.js";

export const functionalNotation = (list: List): List => {
  let isTuple = false;

  const result = list.mapFilter((expr, index, array) => {
    if (expr.isList()) return functionalNotation(expr);
    if (expr.isWhitespace()) return expr;

    const nextExpr = array[index + 1];
    if (nextExpr && nextExpr.isList() && !isOp(expr)) {
      return processFnCall(expr, nextExpr, array, index);
    }

    if (list.mayBeTuple && expr.isIdentifier() && expr.is(",")) {
      isTuple = true;
    }

    return expr;
  });

  if (isTuple) {
    result.insert("tuple");
    result.insert(",");
  }

  return result;
};

const processFnCall = (
  expr: Expr,
  nextExpr: List,
  array: Expr[],
  index: number
): List => {
  if (nextExpr.calls("generics")) {
    return processGenerics(expr, array, index);
  }

  return processParamList(expr, array, index);
};

const processGenerics = (expr: Expr, array: Expr[], index: number): List => {
  const generics = array.splice(index + 1, 1)[0] as List;
  generics.mayBeTuple = false;

  const list = array[index + 1]?.isList()
    ? (array.splice(index + 1, 1)[0] as List)
    : new List({});

  list.insert(",");
  list.insert(expr);
  list.mayBeTuple = false;
  const functional = functionalNotation(list);

  functional.insert(functionalNotation(generics), 2);
  functional.insert(",", 3);
  return functional;
};

const processParamList = (expr: Expr, array: Expr[], index: number): List => {
  const list = array.splice(index + 1, 1)[0] as List;
  list.insert(expr);
  list.insert(",", 1);
  list.mayBeTuple = false;
  return functionalNotation(list);
};
