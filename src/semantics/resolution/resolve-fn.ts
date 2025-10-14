import { Call } from "../../syntax-objects/call.js";
import { Expr } from "../../syntax-objects/expr.js";
import { Fn } from "../../syntax-objects/fn.js";
import { Implementation } from "../../syntax-objects/implementation.js";
import { List } from "../../syntax-objects/list.js";
import { Parameter } from "../../syntax-objects/parameter.js";
import { Identifier } from "../../syntax-objects/identifier.js";
import { TypeAlias, selfType } from "../../syntax-objects/types.js";
import { nop } from "../../syntax-objects/index.js";
import { getExprType } from "./get-expr-type.js";
import { Block } from "../../syntax-objects/block.js";
import { resolveWithExpected, isConcreteType } from "./resolve-entities.js";
import { resolveTypeExpr } from "./resolve-type-expr.js";
import {
  inferTypeArgs,
  TypeArgInferencePair,
  unifyTypeParams,
} from "./infer-type-args.js";
import { typesAreEqual } from "./types-are-equal.js";
import { typesAreCompatible } from "./types-are-compatible.js";
import { Type } from "../../syntax-objects/types.js";
import { canonicalType } from "../types/canonicalize.js";
import { containsUnresolvedTypeId } from "./resolve-object-type.js";
import { registerTypeInstance } from "../../syntax-objects/type-context.js";

export type ResolveFnTypesOpts = {
  typeArgs?: List;
  args?: List;
};

const resolveFnBody = (
  body: Expr | undefined,
  expected?: Type,
  aliasArg?: TypeAlias
): Expr | undefined => {
  if (!body) return undefined;
  const resolved = resolveWithExpected(body, undefined);
  return expected
    ? applyExpectedToTail(resolved, expected, aliasArg)
    : resolved;
};

const applyExpectedToTail = (
  expr: Expr,
  expected: Type,
  aliasArg?: TypeAlias
): Expr => {
  if (expr.isBlock?.()) {
    const block = expr as Block;
    const lastIndex = block.body.length - 1;
    block.applyMap((child, index) =>
      index === lastIndex
        ? resolveTailWithExpected(child, expected, aliasArg)
        : child
    );
    const last = block.lastExpr();
    block.type = last ? getExprType(last) : undefined;
    return block;
  }
  return resolveTailWithExpected(expr, expected, aliasArg);
};

const resolveTailWithExpected = (
  expr: Expr,
  expected: Type,
  aliasArg?: TypeAlias
): Expr => {
  const resolved = resolveWithExpected(expr, expected);
  if (aliasArg && resolved.isCall?.()) {
    const call = resolved as Call;
    const callType = call.type;
    if (callType?.isObjectType?.()) {
      callType.appliedTypeArgs = [aliasArg];
      if (!call.typeArgs) {
        const identifier = aliasArg.name.clone();
        identifier.parent = call;
        call.typeArgs = new List({ value: [identifier] });
      }
    }
  }
  const currentType = getExprType(resolved);
  if (!currentType) {
    (resolved as any).type = expected;
  }
  return resolved;
};

const extractReturnAlias = (fn: Fn): TypeAlias | undefined => {
  const returnExpr = fn.returnTypeExpr;
  if (!returnExpr?.isCall?.()) return undefined;
  const firstArg = returnExpr.typeArgs?.exprAt(0);
  if (!firstArg?.isIdentifier?.()) return undefined;
  const resolved = firstArg.resolve();
  return resolved?.isTypeAlias?.() ? (resolved as TypeAlias) : undefined;
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
  const implGenericCount = fn.parentImpl?.typeParams.length ?? 0;
  const traitGenericCount = fn.parentTrait?.typeParameters?.length ?? 0;
  const hasFnGenerics = fn.typeParameters && fn.typeParameters.length > 0;
  const isModuleLevelFn = fn.parent?.isModule?.() ?? false;
  const returnTypeHasFreeParams =
    !!fn.returnTypeExpr && containsUnresolvedTypeId(fn.returnTypeExpr);
  const canThreadExpected =
    !!fn.annotatedReturnType &&
    !hasFnGenerics &&
    implGenericCount === 0 &&
    traitGenericCount === 0 &&
    isModuleLevelFn &&
    isConcreteType(fn.annotatedReturnType) &&
    !returnTypeHasFreeParams;
  const expectedReturnType = canThreadExpected
    ? fn.annotatedReturnType
    : undefined;
  const explicitAlias = expectedReturnType ? extractReturnAlias(fn) : undefined;
  fn.body = resolveFnBody(fn.body, expectedReturnType, explicitAlias);
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

    if (p.isOptional) {
      p.typeExpr = new Call({
        ...p.typeExpr.metadata,
        fnName: Identifier.from("Optional"),
        args: new List({ value: [] }),
        typeArgs: new List({ value: [p.typeExpr] }),
      });
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

const inferCallTypeArgs = (fn: Fn, call: Call) => {
  const pairs: TypeArgInferencePair[] = [];

  fn.parameters.forEach((param, index) => {
    const arg = call.argAt(index);
    const val = arg?.isCall() && arg.calls(":") ? arg.argAt(1) : arg;
    if (!val || !param.typeExpr) return;
    pairs.push({ typeExpr: param.typeExpr, argExpr: val });
  });

  // Base inference from parameter positions
  const inferred = inferTypeArgs(fn.typeParameters, pairs);
  const paramMap = new Map<string, Type>();
  if (inferred) {
    inferred.toArray().forEach((a) => {
      const alias = a as TypeAlias;
      if (alias.name && alias.type) paramMap.set(alias.name.value, alias.type);
    });
  }

  // Contextual return-type inference: If the call has an expected type and the
  // function has a return type expression (e.g., Array<O>), prefer binding O to
  // the contextual branch when it matches by nominal head (e.g., Array in
  // MsgPack = Map | Array | String).
  const expected = call.getAttribute("expectedType") as Type | undefined;
  let retMap: Map<string, Type> | undefined;
  if (expected && fn.returnTypeExpr) {
    // Helper: compute the nominal head key
    const headKeyFromType = (t?: Type): string | undefined => {
      if (!t) return undefined;
      if (t.isObjectType()) {
        return t.genericParent ? t.genericParent.name.value : t.name.value;
      }
      if (t.isPrimitiveType()) return t.name.value;
      if (t.isTraitType()) return t.name.value;
      if (t.isFixedArrayType()) return "FixedArray";
      if (t.isIntersectionType())
        return headKeyFromType(t.nominalType ?? t.structuralType);
      if (t.isTypeAlias()) return headKeyFromType(t.type);
      return t.name.value;
    };
    const headKeyFromReturnExpr = (): string | undefined => {
      const r = fn.returnTypeExpr!;
      if (r.isCall()) return r.fnName.value;
      if (r.isIdentifier()) return r.value;
      if (r.isType()) return headKeyFromType(r);
      return undefined;
    };

    const returnHead = headKeyFromReturnExpr();
    let expectedForReturn: Type | undefined = expected;
    if (expected.isUnionType() && returnHead) {
      expectedForReturn = expected.types.find(
        (t) => headKeyFromType(t) === returnHead
      );
    }

    if (expectedForReturn) {
      // Reuse core unifier for a single synthetic pair (return type vs expected)
      retMap = unifyTypeParams(
        fn.typeParameters ?? [],
        fn.returnTypeExpr,
        expectedForReturn
      );
    }
  }

  // Merge: prefer contextual return binding when it widens the param-based one
  const chosen: Expr[] = [];
  if (!fn.typeParameters || fn.typeParameters.length === 0) return undefined;
  for (const tp of fn.typeParameters) {
    const name = tp.value;
    const p = paramMap.get(name);
    const r = retMap?.get(name);
    let pick: Type | undefined = r ?? p;
    if (r && p && !typesAreEqual(r, p)) {
      pick = typesAreCompatible(p, r) ? r : p;
    }
    if (!pick) return undefined;
    // Use the Type object directly as a type expression; resolver accepts Types as Exprs
    chosen.push(pick as unknown as Expr);
  }

  return new List({ value: chosen });
};

const fnTypeArgsMatch = (args: List, candidate: Fn): boolean =>
  candidate.appliedTypeArgs
    ? candidate.appliedTypeArgs.every((t, i) => {
        const argType = getExprType(args.at(i));
        const appliedType = getExprType(t);
        const canonArg = argType && canonicalType(argType);
        const canonApplied = appliedType && canonicalType(appliedType);
        return typesAreEqual(canonArg, canonApplied);
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
    const typeAlias = registerTypeInstance(
      new TypeAlias({ name: identifier, typeExpr: typeArg.clone() })
    );
    typeAlias.parent = newFn;
    resolveTypeExpr(typeArg);
    const resolved = getExprType(typeArg);
    if (resolved) {
      typeAlias.type = registerTypeInstance(resolved);
    }
    newFn.appliedTypeArgs?.push(typeAlias);
    newFn.registerEntity(typeAlias);
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

const getParentImpl = (expr: Expr): Implementation | undefined => {
  if (expr.syntaxType === "implementation") return expr;
  if (expr.parent) return getParentImpl(expr.parent);
  return undefined;
};
