import { Form } from "../ast/form.js";
import {
  Expr,
  IdentifierAtom,
  InternalIdentifierAtom,
  isForm,
  isWhitespaceAtom,
} from "../ast/index.js";
import { isOp } from "../grammar.js";

export const functionalNotation = (form: Form): Form => {
  const callsParen = form.callsInternal("paren");
  const cursor = normalizeParams(form)!.cursor();
  const result: Expr[] = [];
  let isTuple = false;

  while (!cursor.done) {
    const expr = cursor.consume();
    if (!expr) break;

    if (isForm(expr)) {
      result.push(functionalNotation(expr));
      continue;
    }

    if (isWhitespaceAtom(expr)) {
      result.push(expr);
      continue;
    }

    const nextExpr = cursor.peek();

    if (nextExpr && isForm(nextExpr) && !(isOp(expr) || expr.eq(","))) {
      if (nextExpr.callsInternal("generics")) {
        const generics = cursor.consume() as Form;
        const params = cursor.peek();
        if (params && isForm(params)) {
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

    if (callsParen && expr.eq(",")) {
      isTuple = true;
    }

    result.push(expr);
  }

  if (isTuple) {
    return new Form({
      location: form.location?.clone(),
      elements: [new InternalIdentifierAtom("tuple"), ",", ...result],
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
  if (!params.callsInternal("paren")) return params;
  const inner = params.at(1);
  if (isForm(inner)) return inner;

  return new Form({
    elements: params.toArray().slice(2),
    location: params.location?.clone(),
  });
};
