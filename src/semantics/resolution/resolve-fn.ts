import { Call } from "../../syntax-objects/call.js";
import { Expr } from "../../syntax-objects/expr.js";
import { Fn } from "../../syntax-objects/fn.js";
import { Implementation } from "../../syntax-objects/implementation.js";
import { List } from "../../syntax-objects/list.js";
import { Parameter } from "../../syntax-objects/parameter.js";
import { TypeAlias } from "../../syntax-objects/types.js";
import { getExprType } from "./get-expr-type.js";
import { resolveEntities } from "./resolve-entities.js";
import { resolveTypeExpr } from "./resolve-type-expr.js";

export type ResolveFnTypesOpts = {
  typeArgs?: List;
  args?: List;
};

/** Pass call to potentially resolve generics */
export const resolveFn = (fn: Fn, call?: Call): Fn => {
  if (fn.typesResolved) {
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
    fn.returnTypeExpr = resolveTypeExpr(fn.returnTypeExpr);
    fn.annotatedReturnType = getExprType(fn.returnTypeExpr);
    fn.returnType = fn.annotatedReturnType;
  }

  fn.typesResolved = true;
  fn.body = resolveEntities(fn.body);
  fn.inferredReturnType = getExprType(fn.body);
  fn.returnType = fn.annotatedReturnType ?? fn.inferredReturnType;
  fn.parentImpl?.registerMethod(fn); // Maybe do this for module when not in an impl

  return fn;
};

const resolveParameters = (params: Parameter[]) => {
  params.forEach((p) => {
    if (p.type) return;

    if (p.name.is("self")) {
      const impl = getParentImpl(p);
      if (impl) p.type = impl.targetType;
      return;
    }

    if (!p.typeExpr) {
      throw new Error(`Unable to determine type for ${p}`);
    }

    p.typeExpr = resolveTypeExpr(p.typeExpr);
    p.type = getExprType(p.typeExpr);
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
  newFn.appliedTypeArgs = [];

  /** Register resolved type entities for each type param */
  typeParameters.forEach((typeParam, index) => {
    const typeArg = args.exprAt(index);
    const identifier = typeParam.clone();
    const type = new TypeAlias({
      name: identifier,
      typeExpr: typeArg.clone(),
    });
    type.parent = newFn;
    resolveTypeExpr(typeArg);
    type.type = getExprType(typeArg);
    newFn.appliedTypeArgs?.push(type);
    newFn.registerEntity(type);
  });

  if (!newFn.appliedTypeArgs.every((t) => (t as TypeAlias).type)) {
    throw new Error(`Unable to resolve all type args for ${newFn}`);
  }

  const resolvedFn = resolveFn(newFn);
  fn.registerGenericInstance(resolvedFn);
  return fn;
};

const getParentImpl = (expr: Expr): Implementation | undefined => {
  if (expr.syntaxType === "implementation") return expr;
  if (expr.parent) return getParentImpl(expr.parent);
  return undefined;
};
