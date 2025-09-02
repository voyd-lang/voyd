import { Expr } from "../../syntax-objects/expr.js";
import { Identifier } from "../../syntax-objects/identifier.js";
import { nop } from "../../syntax-objects/index.js";
import { List } from "../../syntax-objects/list.js";
import { Type, TypeAlias } from "../../syntax-objects/types.js";
import { getExprType } from "./get-expr-type.js";
import { resolveTypeExpr } from "./resolve-type-expr.js";
import { typesAreEqual } from "./types-are-equal.js";
import { resolveUnionType } from "./resolve-union.js";
import { resolveEntities } from "./resolve-entities.js";

export type TypeArgInferencePair = {
  typeExpr: Expr;
  argExpr: Expr;
};

/**
 * Attempts to unify a parameter type expression against a resolved argument
 * type, binding any occurrences of the provided type parameters to concrete
 * types from the argument. Returns a map of param-name -> inferred Type when
 * successful. Returns undefined when the structures are incompatible or a
 * conflict is detected.
 */
export const unifyTypeParams = (
  typeParams: Identifier[],
  paramTypeExpr: Expr,
  argType: Type
): Map<string, Type> | undefined => {
  const typeParamSet = new Set(typeParams.map((t) => t.value));

  // Helper to unwrap type aliases on the argument side
  const unwrap = (t: Type | undefined): Type | undefined => {
    let cur = t;
    const guard = new Set<string>();
    while (cur?.isTypeAlias() && cur.type && !guard.has(cur.id)) {
      guard.add(cur.id);
      cur = cur.type;
    }
    return cur;
  };

  const bindings = new Map<string, Type>();

  const bind = (name: string, t: Type): boolean => {
    const existing = bindings.get(name);
    if (!existing) {
      bindings.set(name, t);
      return true;
    }
    return typesAreEqual(existing, t);
  };

  const unify = (p: Expr, a: Type): boolean => {
    // Always operate on an unwrapped argument type
    const arg = unwrap(a) ?? a;

    // If the parameter side is an identifier, either bind a type
    // parameter or require exact type equality with a named type.
    if (p.isIdentifier()) {
      const name = p.value;
      if (typeParamSet.has(name)) {
        return bind(name, arg);
      }
      // Non-generic identifier, compare to its resolved type.
      const resolved = getExprType(resolveTypeExpr(p));
      return resolved ? typesAreEqual(resolved, arg) : false;
    }

    // If the parameter side is a type-alias, unwrap to its underlying
    // expression/type and keep unifying structurally.
    if (p.isTypeAlias()) {
      // Prefer unifying via the alias's underlying expression to allow
      // matching generics within the alias body (e.g. Optional<T>).
      const innerExpr = p.typeExpr ?? p;
      return unify(innerExpr, arg);
    }

    // Generic object types expressed as type calls (e.g. Array<T>)
    if (p.isCall()) {
      // If this is a type alias call that resolves to a union (e.g., Html<T> = Array<T> | String),
      // delegate to the union unification logic using the resolved type.
      const resolvedPType = getExprType(p);
      if (resolvedPType?.isUnionType()) {
        return unify(resolvedPType, arg);
      }
      // IMPORTANT: Do not resolve the parameter-side call; resolving can create
      // real generic instances with unresolved type parameters and introduce
      // cycles. Instead, compare by the callee identifier and unify children
      // structurally against the argument's applied type arguments.
      const genericName = p.fnName.value;

      // Try to find the nominal object on the argument side
      const argObj = arg.isObjectType()
        ? arg
        : arg.isIntersectionType()
        ? arg.nominalType
        : undefined;
      if (!argObj) return false;

      const argGenericName = argObj.genericParent
        ? argObj.genericParent.name.value
        : argObj.name.value;
      if (genericName !== argGenericName) return false;

      const paramArgs = p.typeArgs?.toArray() ?? [];
      const applied = argObj.appliedTypeArgs ?? [];
      if (paramArgs.length !== applied.length) return false;

      for (let i = 0; i < paramArgs.length; i++) {
        const paramChild = paramArgs[i]!;
        const appliedChild = applied[i]!;
        const childType = getExprType(appliedChild);
        if (!childType) return false;
        if (!unify(paramChild, childType)) return false;
      }
      return true;
    }

    // Tuple/structural object types: unify the parameter fields against
    // the structural portion of the argument. Extra fields on the
    // argument side are permitted, enabling structural subtyping
    // (i.e. the argument may be a superset of the parameter).
    if (p.isObjectType()) {
      const paramObj = p;
      const target = arg.isIntersectionType()
        ? arg.structuralType ?? arg.nominalType // prefer structural, but fall back to nominal if provided
        : arg;
      if (!target || !target.isObjectType()) return false;

      for (const field of paramObj.fields) {
        const match = target.getField(field.name);
        if (!match || !match.type) return false;
        const fieldExpr = resolveTypeExpr(field.typeExpr);
        if (!unify(fieldExpr, match.type)) return false;
      }
      return true;
    }

    // Intersections on the parameter side: unify against the structural
    // portion. If absent, bail rather than guessing.
    if (p.isIntersectionType()) {
      const structExpr = p.structuralTypeExpr.value;
      return unify(resolveTypeExpr(structExpr), arg);
    }

    // Union support: attempt to match variants by nominal "head" (e.g.
    // Array<T> matches Array<i32>) in an order-insensitive manner. We first
    // try to match identifiable heads uniquely, and then bind any remaining
    // generic-only variants to the remaining argument variants. This remains
    // conservative by failing on ambiguity.
    if (p.isUnionType()) {
      const argUnion = arg.isUnionType() ? resolveUnionType(arg) : undefined;
      if (!argUnion || !argUnion.types.length) return false;

      const paramMembers = p.childTypeExprs
        .toArray()
        .map((e) => resolveTypeExpr(e));
      const argMembers = argUnion.types;

      // Helper: compute a nominal head key for matching
      const headKeyFromType = (t: Type | undefined): string | undefined => {
        if (!t) return undefined;
        if (t.isObjectType()) {
          const obj = t;
          return obj.genericParent
            ? obj.genericParent.name.value
            : obj.name.value;
        }
        if (t.isPrimitiveType()) return t.name.value;
        if (t.isTraitType()) return t.name.value;
        if (t.isFixedArrayType()) return "FixedArray";
        if (t.isFnType()) return "Fn";
        if (t.isIntersectionType())
          return headKeyFromType(t.nominalType ?? t.structuralType);
        if (t.isTypeAlias()) return headKeyFromType(t.type);
        return t.name.value;
      };
      const headKeyFromExpr = (e: Expr): string | undefined => {
        if (e.isCall()) return e.fnName.value;
        if (e.isIdentifier()) {
          // Treat generic params as keyless so they are handled in a second pass
          if (typeParamSet.has(e.value)) return undefined;
          const resolved = getExprType(resolveTypeExpr(e));
          return headKeyFromType(resolved);
        }
        if (e.isTypeAlias()) return headKeyFromExpr(e.typeExpr ?? e);
        if (e.isType()) return headKeyFromType(e);
        return undefined;
      };

      const used = new Array<boolean>(argMembers.length).fill(false);
      const deferred: Expr[] = [];

      // First pass: match variants with identifiable heads
      for (const member of paramMembers) {
        const key = headKeyFromExpr(member);
        if (!key) {
          deferred.push(member);
          continue;
        }
        const candidates: number[] = [];
        for (let j = 0; j < argMembers.length; j++) {
          if (used[j]) continue;
          const head = headKeyFromType(argMembers[j]!);
          if (head && head === key) candidates.push(j);
        }
        if (candidates.length === 0) return false; // missing required variant
        if (candidates.length > 1) return false; // ambiguous head match
        const idx = candidates[0]!;
        if (!unify(member, argMembers[idx]!)) return false;
        used[idx] = true;
      }

      // Second pass: bind remaining generic-only variants to remaining args
      const remainingArgs: Type[] = [];
      for (let j = 0; j < argMembers.length; j++)
        if (!used[j]) remainingArgs.push(argMembers[j]!);
      if (deferred.length !== remainingArgs.length) return false; // require 1-1
      for (let k = 0; k < deferred.length; k++) {
        if (!unify(deferred[k]!, remainingArgs[k]!)) return false;
      }
      return true;
    }

    // Parameter is itself a fully-formed Type object. Require strict
    // equality when comparing against the argument type.
    if (p.isType()) {
      return typesAreEqual(p, arg);
    }

    return false;
  };

  return unify(resolveTypeExpr(paramTypeExpr), argType) ? bindings : undefined;
};

export const inferTypeArgs = (
  typeParams: Identifier[] | undefined,
  pairs: TypeArgInferencePair[]
): List | undefined => {
  if (!typeParams?.length) return;

  // Merge unification results from all provided pairs, ensuring consistency
  // across bindings for the same type parameter.
  const merged = new Map<string, Type>();

  for (const { typeExpr, argExpr } of pairs) {
    const resolvedTypeExpr = resolveTypeExpr(typeExpr);
    if (argExpr.isClosure() && resolvedTypeExpr.isFnType()) {
      argExpr.setAttribute("parameterFnType", resolvedTypeExpr);
    }

    const resolveArgExpr = resolveEntities(argExpr);
    const argType = getExprType(resolveArgExpr);
    if (!argType) return undefined;

    const result = unifyTypeParams(typeParams, resolvedTypeExpr, argType);
    if (!result) return undefined;

    for (const [k, v] of result.entries()) {
      const existing = merged.get(k);
      if (existing && !typesAreEqual(existing, v)) {
        return undefined; // conflicting inference
      }
      merged.set(k, v);
    }
  }

  // Ensure all type params have been inferred
  const inferred: TypeAlias[] = [];
  for (const tp of typeParams) {
    const ty = merged.get(tp.value);
    if (!ty) return undefined;
    const alias = new TypeAlias({ name: tp.clone(), typeExpr: nop() });
    alias.type = ty;
    inferred.push(alias);
  }

  return new List({ value: inferred });
};
