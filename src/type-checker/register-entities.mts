import {
  List,
  Fn,
  Parameter,
  Expr,
  Variable,
  Call,
  Block,
} from "../syntax-objects/index.mjs";
import { TypeChecker } from "./types";

export const registerEntities: TypeChecker = (expr) => {
  if (expr.isModule()) {
    return expr.applyMap(registerEntities);
  }

  if (!expr.isList()) return expr;

  if (expr.calls("define_function")) {
    return initFn(expr);
  }

  if (expr.calls("define") || expr.calls("define_mutable")) {
    return initVar(expr);
  }

  if (expr.calls("block")) {
    return initBlock(expr);
  }

  return initCall(expr);
};

const initBlock = (block: List): Block => {
  return new Block({ ...block.metadata, body: block.slice(1) }).applyMap(
    registerEntities
  );
};

const initFn = (expr: List): Fn => {
  const name = expr.identifierAt(1);
  const parameters = expr
    .listAt(2)
    .sliceAsArray(1)
    .flatMap((p) => listToParameter(p as List));
  const returnTypeExpr = getReturnTypeExprForFn(expr, 3);

  const fn = new Fn({
    name,
    returnTypeExpr: returnTypeExpr,
    parameters,
    ...expr.metadata,
  });

  const body = expr.at(4);

  if (body) {
    body.parent = fn;
    fn.body = registerEntities(body);
  }

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

const initCall = (call: List) => {
  if (!call.length) {
    throw new Error("Invalid fn call");
  }

  const fnName = call.at(0);
  if (!fnName?.isIdentifier()) {
    throw new Error("Invalid fn call");
  }

  const args = call.sliceAsArray(1);
  return new Call({ ...call.metadata, fnName, args });
};
