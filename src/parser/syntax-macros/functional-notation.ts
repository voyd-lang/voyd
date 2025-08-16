import { idIs, isOp } from "../grammar.js";
import { Expr, List, ListValue } from "../../syntax-objects/index.js";

// Simplified iteration to reduce complexity and improve runtime
// performance when converting lists that use functional notation.
export const functionalNotation = (list: List): List => {
  const array = list.toArray();
  const result: ListValue[] = [];
  let isTuple = false;

  for (let i = 0; i < array.length; i++) {
    const expr = array[i];

    if (expr.isList()) {
      result.push(functionalNotation(expr));
      continue;
    }

    if (expr.isWhitespace()) {
      result.push(expr);
      continue;
    }

    const nextExpr = array[i + 1];
    if (
      nextExpr &&
      nextExpr.isList() &&
      !(isOp(expr) || idIs(expr, ","))
    ) {
      if (nextExpr.calls("generics")) {
        const generics = nextExpr;
        const nextNextExpr = array[i + 2];
        if (nextNextExpr && nextNextExpr.isList()) {
          result.push(
            processGenerics(expr, generics, nextNextExpr as List)
          );
          i += 2;
        } else {
          result.push(processGenerics(expr, generics));
          i += 1;
        }
      } else {
        result.push(processParamList(expr, nextExpr as List));
        i += 1;
      }
      continue;
    }

    if (list.getAttribute("tuple?") && idIs(expr, ",")) {
      isTuple = true;
    }

    result.push(expr);
  }

  if (isTuple) {
    result.unshift(",", "tuple");
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

