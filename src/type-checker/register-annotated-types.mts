import {
  List,
  Fn,
  Parameter,
  Expr,
  Variable,
  Identifier,
} from "../syntax-objects/index.mjs";
import { TypeChecker } from "./types";

/** Registers any explicitly type annotated values */
export const registerAnnotatedTypes: TypeChecker = (expr) => {
  if (expr.isModule()) {
    return expr.applyMap(registerAnnotatedTypes);
  }

  if (!expr.isList()) return expr;

  if (expr.calls("define_function")) {
    return initFn(expr);
  }

  if (expr.calls("define") || expr.calls("define_mutable")) {
    return initVar(expr);
  }

  return expr.map(registerAnnotatedTypes);
};

const initFn = (expr: List): Fn => {
  const name = expr.identifierAt(1);
  const parameters = expr
    .listAt(2)
    .sliceAsArray(1)
    .flatMap((p) => listToParameter(p as List));
  const returnTypeExpr = getReturnTypeExprForFn(expr, 3);
  const body = expr.slice(4);

  const fn = new Fn({
    name,
    returnTypeExpr: returnTypeExpr,
    parameters,
    body,
    ...expr.metadata,
  });

  return fn;
};

const listToParameter = (
  list: List,
  labeled = false
): Parameter | Parameter[] => {
  // TODO check for separate external label [: at [: n i32]]
  if (list.identifierAt(0).is(":")) {
    const name = list.identifierAt(1);
    const typeExpr = list.identifierAt(2);
    return new Parameter({
      ...list.metadata,
      name,
      typeExpr,
      label: labeled ? name : undefined,
    });
  }

  if (list.identifierAt(0).is("object")) {
    return list.sliceAsArray(1).flatMap((e) => listToParameter(e as List));
  }

  throw new Error("Invalid parameter");
};

const getReturnTypeExprForFn = (fn: List, index: number): Expr | undefined => {
  const returnDec = fn.at(index);
  if (!returnDec?.isList()) return undefined;
  if (!returnDec.calls("return_type")) return undefined;
  return returnDec.at(1);
};

const initVar = (varDef: List): Variable => {
  const isMutable = varDef.calls("define_mutable");
  const identifierExpr = varDef.at(1);
  const [name, typeExpr] =
    identifierExpr?.isList() && identifierExpr.calls(":")
      ? [identifierExpr.identifierAt(1), identifierExpr.at(2)]
      : identifierExpr?.isIdentifier()
      ? [identifierExpr]
      : [];

  if (!name) {
    throw new Error("Invalid variable definition, invalid identifier");
  }

  const initializer = varDef.at(2);

  if (!initializer) {
    throw new Error("Invalid variable definition, missing initializer");
  }

  return new Variable({
    ...varDef.metadata,
    name,
    typeExpr,
    initializer,
    isMutable,
  });
};
