import { Form } from "../ast/form.js";
import {
  Expr,
  IdentifierAtom,
  idIs,
  is,
  WhitespaceAtom,
} from "../ast/index.js";
import { isOp } from "../grammar.js";

export const functionalNotation = (form: Form): Form => {
  const callsParen = form.callsInternal("paren");
  const cursor = (callsParen ? (form.at(1) as Form) : form).cursor();
  const result: Expr[] = [];
  let isTuple = false;

  while (!cursor.done) {
    const expr = cursor.consume();
    if (!expr) break;

    if (is(expr, Form)) {
      result.push(functionalNotation(expr));
      continue;
    }

    if (is(expr, WhitespaceAtom)) {
      result.push(expr);
      continue;
    }

    const nextExpr = cursor.peek();

    if (nextExpr && is(nextExpr, Form) && !(isOp(expr) || idIs(expr, ","))) {
      if (nextExpr.callsInternal("generics")) {
        const generics = cursor.consume() as Form;
        const params = cursor.peek();
        if (params && is(params, Form)) {
          result.push(
            processGenerics(expr, generics, cursor.consume() as Form)
          );
        } else {
          result.push(processGenerics(expr, generics));
        }
      } else {
        result.push(processParamList(expr, cursor.consume() as Form));
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
      location: form.location?.clone(),
      elements: ["tuple", ",", ...result],
    });
  }

  return new Form({ location: form.location?.clone(), elements: result });
};

const processGenerics = (expr: Expr, generics: Form, params?: Form): Form => {
  const normalizedParams = normalizeParams(params);
  const paramElements = Form.elementsOf(normalizedParams);
  const list = new Form([expr, ",", ...paramElements]);
  const functional = functionalNotation(list).toArray();
  functional.splice(2, 0, functionalNotation(generics));
  functional.splice(3, 0, new IdentifierAtom(","));
  return new Form({ elements: functional });
};

const processParamList = (expr: Expr, params: Form): Form => {
  const normalizedParams = normalizeParams(params);
  const paramElements = Form.elementsOf(normalizedParams);
  return functionalNotation(new Form([expr, ",", ...paramElements]));
};

const normalizeParams = (params?: Form): Form | undefined => {
  if (!params) return undefined;
  return params.callsInternal("paren") ? (params.at(1) as Form) : params;
};
