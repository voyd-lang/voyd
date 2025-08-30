import { Call } from "../../syntax-objects/call.js";
import { Expr } from "../../syntax-objects/expr.js";
import { Fn } from "../../syntax-objects/fn.js";
import { Implementation } from "../../syntax-objects/implementation.js";
import { List } from "../../syntax-objects/list.js";
import { Parameter } from "../../syntax-objects/parameter.js";
import { TypeAlias, selfType } from "../../syntax-objects/types.js";
import { nop } from "../../syntax-objects/index.js";
import { getExprType } from "./get-expr-type.js";
import { resolveEntities } from "./resolve-entities.js";
import { resolveTypeExpr } from "./resolve-type-expr.js";
import { inferTypeArgs, TypeArgInferencePair } from "./infer-type-args.js";
import { typesAreEqual } from "./types-are-equal.js";

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
    // Even if we can't resolve a generic function without a call, make sure
    // it's discoverable on its parent implementation for candidate selection.
    fn.parentImpl?.registerMethod(fn);
    return fn;
  }

  resolveFnSignature(fn);

  fn.typesResolved = true;
  fn.body = fn.body ? resolveEntities(fn.body) : undefined;
  fn.inferredReturnType = getExprType(fn.body);
  if (
    fn.annotatedReturnType?.isPrimitiveType() &&
    (fn.annotatedReturnType.name.value === "void" ||
      fn.annotatedReturnType.name.value === "voyd")
  ) {
    fn.inferredReturnType = fn.annotatedReturnType;
  }
  fn.returnType = fn.annotatedReturnType ?? fn.inferredReturnType;
  fn.parentImpl?.registerMethod(fn); // Maybe do this for module when not in an impl

  return fn;
};

export const resolveFnSignature = (fn: Fn) => {
  resolveParameters(fn.parameters);
  if (fn.returnTypeExpr) {
    fn.returnTypeExpr = resolveTypeExpr(fn.returnTypeExpr);
    fn.annotatedReturnType = getExprType(fn.returnTypeExpr);
    fn.returnType = fn.annotatedReturnType;
  }

  return fn;
};

const resolveParameters = (params: Parameter[]) => {
  params.forEach((p) => {
    if (p.type) return;

    if (p.name.is("self")) {
      const impl = getParentImpl(p);
      // Use a Self type that is scoped to the surrounding trait so trait
      // methods can properly resolve their `Self` parameter. This allows
      // compatibility checks to detect when a concrete implementation is
      // providing the first parameter expected by a trait method.
      p.type = impl ? impl.targetType : selfType.clone(p);
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
  const args = call.typeArgs ?? inferCallTypeArgs(fn, call);
  if (!args) return fn;
  const existing = fn.genericInstances?.find((c) => fnTypeArgsMatch(args, c));
  if (existing) return fn;

  return resolveGenericsWithTypeArgs(fn, args);
};

export const inferCallTypeArgs = (fn: Fn, call: Call) => {
  const pairs: TypeArgInferencePair[] = [];

  fn.parameters.forEach((param, index) => {
    const arg = call.argAt(index);
    const val = arg?.isCall() && arg.calls(":") ? arg.argAt(1) : arg;
    if (!val || !param.typeExpr) return;
    pairs.push({ typeExpr: param.typeExpr, argExpr: val });
  });

  const inferred = inferTypeArgs(fn.typeParameters, pairs);
  if (!inferred) return undefined;

  // Convert inferred aliases into concrete type expressions for the call
  // to avoid attaching alias objects to the call node (which can create
  // cyclic structures during cloning in some cases). Preserve order.
  const typeExprs = inferred
    .toArray()
    .map((alias) => (alias as TypeAlias).type ?? (alias as TypeAlias).typeExpr)
    .filter((t): t is Expr => !!t);

  return new List({ value: typeExprs });
};

const fnTypeArgsMatch = (args: List, candidate: Fn): boolean =>
  candidate.appliedTypeArgs
    ? candidate.appliedTypeArgs.every((t, i) => {
        const argType = getExprType(args.at(i));
        const appliedType = getExprType(t);
        return typesAreEqual(argType, appliedType);
      })
    : false;

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
    const type = new TypeAlias({ name: identifier, typeExpr: typeArg.clone() });
    type.parent = newFn;
    resolveTypeExpr(typeArg);
    type.type = getExprType(typeArg);
    newFn.appliedTypeArgs?.push(type);
    newFn.registerEntity(type);
  });

  if (!newFn.appliedTypeArgs.every((t) => (t as TypeAlias).type)) {
    // Do not create an unresolved instance; let caller continue without
    // specializing this generic function.
    return fn;
  }

  const resolvedFn = resolveFn(newFn);
  fn.registerGenericInstance(resolvedFn);
  return fn;
};

// Signature-only specialization for candidate discovery
export const resolveGenericsWithTypeArgsSignatureOnly = (
  fn: Fn,
  args: List
): Fn => {
  const typeParameters = fn.typeParameters!;

  if (args.length !== typeParameters.length) {
    return fn;
  }

  const newFn = fn.clone();
  newFn.typeParameters = undefined;
  newFn.appliedTypeArgs = [];

  typeParameters.forEach((typeParam, index) => {
    const typeArg = args.exprAt(index);
    const identifier = typeParam.clone();
    const type = new TypeAlias({ name: identifier, typeExpr: typeArg.clone() });
    type.parent = newFn;
    resolveTypeExpr(typeArg);
    type.type = getExprType(typeArg);
    newFn.appliedTypeArgs?.push(type);
    newFn.registerEntity(type);
  });

  if (!newFn.appliedTypeArgs.every((t) => (t as TypeAlias).type)) {
    return fn;
  }

  resolveFnSignature(newFn);
  fn.registerGenericInstance(newFn);
  return fn;
};

const getParentImpl = (expr: Expr): Implementation | undefined => {
  if (expr.syntaxType === "implementation") return expr;
  if (expr.parent) return getParentImpl(expr.parent);
  return undefined;
};
