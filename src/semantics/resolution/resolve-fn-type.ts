import { Fn } from "../../syntax-objects/fn.js";
import { Parameter } from "../../syntax-objects/parameter.js";
import { getExprType } from "./get-expr-type.js";
import { resolveTypes } from "./resolve-types.js";

export const resolveFnTypes = (fn: Fn): Fn => {
  if (fn.returnType) {
    // Already resolved
    return fn;
  }

  resolveParameters(fn.parameters);
  if (fn.returnTypeExpr) {
    fn.annotatedReturnType = getExprType(fn.returnTypeExpr);
    fn.returnType = fn.annotatedReturnType;
  }

  fn.body = resolveTypes(fn.body);
  fn.inferredReturnType = getExprType(fn.body);
  fn.returnType = fn.annotatedReturnType ?? fn.inferredReturnType;

  return fn;
};

const resolveParameters = (params: Parameter[]) => {
  params.forEach((p) => {
    if (!p.typeExpr) {
      throw new Error(`Unable to determine type for ${p}`);
    }

    const type = getExprType(p.typeExpr);
    if (!type) {
      throw new Error(`Unable to resolve type for ${p}`);
    }

    p.type = type;
  });
};
