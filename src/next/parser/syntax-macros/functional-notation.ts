import { Form } from "../ast/form.js";
import {
  Expr,
  IdentifierAtom,
  idIs,
  is,
  WhitespaceAtom,
} from "../ast/index.js";
import { isOp } from "../grammar.js";

// TODO: Update top location by between first child and end child (to replace dynamicLocation)
export const functionalNotation = (form: Form): Form => {
  const callsParen = form.callsInternal("paren");
  const array = callsParen ? (form.at(1) as Form).toArray() : form.toArray(); // TODO: Assert the form.at(1)
  const result: Expr[] = [];
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
      if (nextExpr.callsInternal("generics")) {
        const generics = nextExpr;
        const nextNextExpr = array[index + 2];
        if (nextNextExpr && is(nextNextExpr, Form)) {
          result.push(processGenerics(expr, generics, nextNextExpr));
          skip = 2;
        } else {
          result.push(processGenerics(expr, generics));
          skip = 1;
        }
      } else {
        const call = processParamList(expr, nextExpr);
        result.push(call);
        skip = 1;
      }
      continue;
    }

    if (callsParen && idIs(expr, ",")) {
      isTuple = true;
    }

    result.push(expr);
  }

  if (isTuple) {
    return new Form({
      location: form.location,
      elements: ["tuple", ",", ...result],
    });
  }

  return new Form({ location: form.location, elements: result });
};

const processGenerics = (expr: Expr, generics: Form, params?: Form): Form => {
  const normalizedParams = normalizeParams(params);
  const location = params?.location ?? generics.location ?? expr.location;
  const list = new Form({
    elements: [expr, ",", ...(normalizedParams?.toArray() ?? [])],
    location,
  });
  const functional = functionalNotation(list).toArray();
  functional.splice(2, 0, functionalNotation(generics));
  functional.splice(3, 0, new IdentifierAtom(","));
  return new Form({ elements: functional, location });
};

const processParamList = (expr: Expr, params: Form): Form => {
  const normalizedParams = normalizeParams(params);
  const location = params.location ?? normalizedParams?.location ?? expr.location;
  return functionalNotation(
    new Form({
      elements: [expr, ",", ...(normalizedParams?.toArray() ?? [])],
      location,
    })
  );
};

const normalizeParams = (params?: Form): Form | undefined => {
  if (!params) return undefined;
  return params.callsInternal("paren") ? (params.at(1) as Form) : params;
};
