import { idIs, isOp } from "../grammar.js";
import { Expr, List, ListValue } from "../../syntax-objects/index.js";

// Simplified and optimized version of functional notation parsing.
// Uses a single pass with a basic for-loop to minimize overhead.

export const functionalNotation = (list: List): List => {
  const array = list.toArray();
  const result: ListValue[] = [];
  const tupleAttr = list.getAttribute("tuple?");
  let skip = 0;
  let isTuple = false;

  for (let index = 0; index < array.length; index++) {
    const expr = array[index];

    if (skip > 0) {
      skip--;
      continue;
    }

    if (expr.isList()) {
      result.push(functionalNotation(expr));
      continue;
    }

    if (expr.isWhitespace()) {
      result.push(expr);
      continue;
    }

    const nextExpr = array[index + 1];

    if (nextExpr && nextExpr.isList() && !(isOp(expr) || idIs(expr, ","))) {
      if (nextExpr.calls("generics")) {
        const generics = nextExpr;
        const nextNextExpr = array[index + 2];
        if (nextNextExpr && nextNextExpr.isList()) {
          result.push(
            processGenerics(expr, generics, nextNextExpr as List)
          );
          skip = 2;
        } else {
          result.push(processGenerics(expr, generics));
          skip = 1;
        }
      } else {
        result.push(processParamList(expr, nextExpr as List));
        skip = 1;
      }
      continue;
    }

    if (tupleAttr && idIs(expr, ",")) {
      isTuple = true;
    }

    result.push(expr);
  }

  if (isTuple) {
    result.unshift(",");
    result.unshift("tuple");
  }
  return new List({ ...list.metadata, value: result });
};

const processGenerics = (expr: Expr, generics: List, params?: List): List => {
  generics.setAttribute("tuple?", false);

  const list = params || new List([]);
  list.insert(expr);
  list.insert(",", 1);
  list.setAttribute("tuple?", false);
  const functional = functionalNotation(list);

  functional.insert(functionalNotation(generics), 2);
  functional.insert(",", 3);
  return functional;
};

const processParamList = (expr: Expr, params: List): List => {
  params.insert(expr);
  params.insert(",", 1);
  params.setAttribute("tuple?", false);
  return functionalNotation(params);
};
