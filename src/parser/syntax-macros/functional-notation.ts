import { idIs, isOp } from "../grammar.js";
import { Expr, List, ListValue } from "../../syntax-objects/index.js";

export const functionalNotation = (list: List): List => {
  const array = list.toArray();
  let isTuple = false;

  const { result } = array.reduce(
    (acc, expr, index) => {
      if (acc.skip > 0) {
        acc.skip--;
        return acc;
      }

      if (expr.isList()) {
        acc.result.push(functionalNotation(expr));
        return acc;
      }

      if (expr.isWhitespace()) {
        acc.result.push(expr);
        return acc;
      }

      const nextExpr = array[index + 1];

      if (nextExpr && nextExpr.isList() && !(isOp(expr) || idIs(expr, ","))) {
        return handleNextExpression(acc, expr, nextExpr, array, index);
      }

      if (list.mayBeTuple && idIs(expr, ",")) {
        isTuple = true;
      }

      acc.result.push(expr);
      return acc;
    },
    { result: [], skip: 0 } as Accumulator
  );

  return finalizeResult(result, isTuple);
};

type Accumulator = { result: ListValue[]; skip: number };

const handleNextExpression = (
  acc: Accumulator,
  expr: Expr,
  nextExpr: Expr,
  array: Expr[],
  index: number
) => {
  if ((nextExpr as List).calls("generics")) {
    const generics = nextExpr as List;
    const nextNextExpr = array[index + 2];
    if (nextNextExpr && nextNextExpr.isList()) {
      acc.result.push(processGenerics(expr, generics, nextNextExpr as List));
      acc.skip = 2; // Skip next two expressions
    } else {
      acc.result.push(processGenerics(expr, generics));
      acc.skip = 1; // Skip next expression
    }
  } else {
    acc.result.push(processParamList(expr, nextExpr as List));
    acc.skip = 1; // Skip next expression
  }
  return acc;
};

const finalizeResult = (result: ListValue[], isTuple: boolean): List => {
  if (isTuple) {
    result.unshift(",");
    result.unshift("tuple");
  }
  return new List(result);
};

const processGenerics = (expr: Expr, generics: List, params?: List): List => {
  generics.mayBeTuple = false;

  const list = params || new List([]);
  list.insert(expr);
  list.insert(",", 1);
  list.mayBeTuple = false;
  const functional = functionalNotation(list);

  functional.insert(functionalNotation(generics), 2);
  functional.insert(",", 3);
  return functional;
};

const processParamList = (expr: Expr, params: List): List => {
  params.insert(expr);
  params.insert(",", 1);
  params.mayBeTuple = false;
  return functionalNotation(params);
};
