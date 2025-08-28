import { Expr } from "../../syntax-objects/expr.js";
import { Identifier } from "../../syntax-objects/identifier.js";
import { nop } from "../../syntax-objects/index.js";
import { List } from "../../syntax-objects/list.js";
import { Type, TypeAlias } from "../../syntax-objects/types.js";
import { getExprType } from "./get-expr-type.js";
import { resolveTypeExpr } from "./resolve-type-expr.js";
import { typesAreEqual } from "./types-are-equal.js";

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

    // Tuple/structural object types: unify field-by-field against the
    // structural side of the argument when available.
    if (p.isObjectType()) {
      const paramObj = p;
      const target = arg.isIntersectionType()
        ? arg.structuralType ?? arg.nominalType // prefer structural, but fall back to nominal if provided
        : arg;
      if (!target || !target.isObjectType()) return false;

      // For now require exact field correspondence (tuple-like behavior).
      if (paramObj.fields.length !== target.fields.length) return false;

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

    // Unions and other constructs are not supported for structural inference
    // beyond trivial exact matches.
    if (p.isUnionType()) {
      const pType = getExprType(resolveTypeExpr(p));
      return pType ? typesAreEqual(pType, arg) : false;
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
    // Resolve the argument type. If not resolvable, inference fails.
    const argType = getExprType(argExpr);
    if (!argType) return undefined;

    const result = unifyTypeParams(typeParams, typeExpr, argType);
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
