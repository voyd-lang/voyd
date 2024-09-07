import { Call } from "../../syntax-objects/call.js";
import { Fn } from "../../syntax-objects/fn.js";
import { List } from "../../syntax-objects/list.js";
import { Parameter } from "../../syntax-objects/parameter.js";
import { TypeAlias } from "../../syntax-objects/types.js";
import { getExprType } from "./get-expr-type.js";
import { resolveTypes } from "./resolve-types.js";

export type ResolveFnTypesOpts = {
  typeArgs?: List;
  args?: List;
};

/** Pass call to potentially resolve generics */
export const resolveFnTypes = (fn: Fn, call?: Call): Fn => {
  if (fn.resolved) {
    // Already resolved
    return fn;
  }

  if (fn.typeParameters && call) {
    // May want to check if there is already a resolved instance with matching type args here
    // currently get-call-fn.ts does this, but it may be better to do it here
    return attemptToResolveFnWithGenerics(fn, call);
  }

  if (fn.typeParameters && !call) {
    return fn;
  }

  resolveParameters(fn.parameters);
  if (fn.returnTypeExpr) {
    fn.annotatedReturnType = getExprType(fn.returnTypeExpr);
    fn.returnType = fn.annotatedReturnType;
  }

  fn.resolved = true;
  fn.body = resolveTypes(fn.body);
  fn.inferredReturnType = getExprType(fn.body);
  fn.returnType = fn.annotatedReturnType ?? fn.inferredReturnType;

  return fn;
};

const resolveParameters = (params: Parameter[]) => {
  params.forEach((p) => {
    if (p.type) {
      return;
    }

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

const attemptToResolveFnWithGenerics = (fn: Fn, call: Call): Fn => {
  if (call.typeArgs) {
    return resolveGenericsWithTypeArgs(fn, call.typeArgs);
  }

  // TODO try type inference with args
  return fn;
};

const resolveGenericsWithTypeArgs = (fn: Fn, args: List): Fn => {
  const typeParameters = fn.typeParameters!;

  if (args.length !== typeParameters.length) {
    return fn;
  }

  const newFn = fn.clone();
  newFn.typeParameters = undefined;

  /** Register resolved type entities for each type param */
  typeParameters.forEach((typeParam, index) => {
    const typeArg = args.exprAt(index);
    const identifier = typeParam.clone();
    const type = new TypeAlias({
      name: identifier,
      typeExpr: typeArg,
    });
    type.type = getExprType(typeArg);
    newFn.registerEntity(type);
  });

  const resolvedFn = resolveFnTypes(newFn);
  fn.registerGenericInstance(resolvedFn);
  return fn;
};
