import { CallForm, Form, FormElementInitVal, ParenForm } from "../ast/form.js";
import {
  call,
  IdentifierAtom,
  idIs,
  is,
  tuple,
  WhitespaceAtom,
} from "../ast/index.js";
import { isOp } from "../grammar.js";

// Simplified and optimized version of functional notation parsing.
// Uses a single pass with a basic for-loop to minimize overhead.

export const functionalNotation = (list: Form): Form => {
  const array = list.toArray();
  const result: FormElementInitVal = [];

  let skip = 0;
  let isTuple = false;

  for (let index = 0; index < array.length; index++) {
    const expr = array[index];

    if (skip > 0) {
      skip--;
      continue;
    }

    if (is(expr, Form)) {
      result.push(functionalNotation(expr));
      continue;
    }

    if (is(expr, WhitespaceAtom)) {
      result.push(expr);
      continue;
    }

    const nextExpr = array[index + 1];

    if (nextExpr && is(nextExpr, Form) && !(isOp(expr) || idIs(expr, ","))) {
      if (is(nextExpr, CallForm) && nextExpr.calls("generics")) {
        const generics = nextExpr;
        const nextNextExpr = array[index + 2];
        if (is(nextNextExpr, Form)) {
          result.push(processGenerics(expr, generics, nextNextExpr));
          skip = 2;
        } else {
          result.push(processGenerics(expr, generics));
          skip = 1;
        }
      } else {
        const call = processParamList(expr as IdentifierAtom, nextExpr); // TODO: IdentifierAtom assertion
        result.push(call);
        skip = 1;
      }
      continue;
    }

    if (is(list, ParenForm) && idIs(expr, ",")) {
      isTuple = true;
    }

    result.push(expr);
  }

  if (isTuple) {
    return tuple(...result).setLocation(list.location);
  }

  return new List({ ...list.metadata, value: result });
};

const processGenerics = (
  expr: Expr,
  generics: CallForm,
  params?: List
): List => {
  const list = params || new List([]);
  list.insert(expr);
  list.insert(",", 1);
  list.setAttribute("tuple?", false);
  const functional = functionalNotation(list);

  functional.insert(functionalNotation(generics), 2);
  functional.insert(",", 3);
  return functional;
};

const processParamList = (expr: IdentifierAtom, params: Form): CallForm => {
  return call(expr, ...functionalNotation(params).toArray());
};
