import { nop } from "../../syntax-objects/lib/helpers.js";
import { Implementation } from "../../syntax-objects/implementation.js";
import { ObjectType, TypeAlias } from "../../syntax-objects/types.js";
import { Fn } from "../../syntax-objects/fn.js";
import { Expr } from "../../syntax-objects/expr.js";
import { getExprType } from "./get-expr-type.js";
import { resolveObjectType } from "./resolve-object-type.js";
import { resolveEntities } from "./resolve-entities.js";
import { resolveTypeExpr } from "./resolve-type-expr.js";
import { TraitType } from "../../syntax-objects/types/trait.js";
import { typesAreCompatible } from "./types-are-compatible.js";
import { resolveFn, resolveFnSignature } from "./resolve-fn.js";
import { resolveExport } from "./resolve-use.js";

export const resolveImpl = (
  impl: Implementation,
  targetType?: ObjectType
): Implementation => {
  if (impl.typesResolved) return impl;
  targetType = targetType ?? getTargetType(impl);
  impl.targetType = targetType;

  // Pre-register methods so sibling calls inside nested scopes (e.g., match arms)
  // can resolve them even before the impl body is fully resolved. This mirrors
  // how module-level exports are discoverable early and avoids timing holes
  // where lexical lookup yields zero candidates during resolve.
  preRegisterImplMethods(impl);

  if (targetType?.appliedTypeArgs) {
    targetType.appliedTypeArgs.forEach((arg, index) => {
      const typeParam = impl.typeParams.at(index);
      if (!typeParam) {
        throw new Error(`Type param not found for ${arg} at ${impl.location}`);
      }
      const type = new TypeAlias({
        name: typeParam.clone(),
        typeExpr: nop(),
      });
      resolveTypeExpr(arg);
      type.type = getExprType(arg);
      impl.registerEntity(type);
    });
  }

  impl.trait = getTrait(impl);
  if (impl.trait) {
    impl.trait.implementations.push(impl);
  }

  if (!targetType) return impl;

  if (targetType?.isObjectType()) {
    targetType.implementations?.push(impl);
  }

  if (targetType?.isObjectType() && targetType.typeParameters?.length) {
    // Apply impl to existing generic instances
    targetType.genericInstances?.forEach((obj) =>
      resolveImpl(impl.clone(), obj)
    );

    return impl;
  }

  impl.typesResolved = true;
  impl.body.value = resolveEntities(impl.body.value);
  resolveDefaultTraitMethods(impl);

  return impl;
};

/**
 * Resolve only method signatures and generic type bindings for an
 * implementation. Avoids resolving the impl body and default trait methods.
 * Used during candidate discovery to keep specialization lazy.
 */
export const resolveImplSignatures = (
  impl: Implementation,
  targetType?: ObjectType
): Implementation => {
  // Bind target type and generic aliases if provided so parameter typeExprs
  // can reference concrete type arguments (e.g., T -> i32).
  targetType = targetType ?? getTargetType(impl);
  impl.targetType = targetType;

  if (targetType?.appliedTypeArgs) {
    targetType.appliedTypeArgs.forEach((arg, index) => {
      const typeParam = impl.typeParams.at(index);
      if (!typeParam) return;
      const alias = new TypeAlias({ name: typeParam.clone(), typeExpr: nop() });
      resolveTypeExpr(arg);
      alias.type = getExprType(arg);
      impl.registerEntity(alias);
    });
  }

  // Pre-register and resolve only signatures for methods in this impl
  preRegisterImplMethods(impl);
  impl.methods.forEach((m) => resolveFnSignature(m));

  // Resolve and attach trait (do not resolve default methods here)
  impl.trait = getTrait(impl);
  if (impl.trait) {
    impl.trait.implementations.push(impl);
  }

  // Ensure the implementation is attached to the target type so that
  // candidate discovery can find its methods.
  if (targetType?.isObjectType()) {
    if (!targetType.implementations) targetType.implementations = [];
    if (!targetType.implementations.includes(impl)) {
      targetType.implementations.push(impl);
    }
  }

  return impl;
};

const preRegisterImplMethods = (impl: Implementation): void => {
  const seen = new Set<string>();
  const register = (fn: Fn, exported: boolean) => {
    if (seen.has(fn.id)) return;
    seen.add(fn.id);
    if (exported) impl.registerExport(fn);
    // Ensure methods are addressable within the impl even if not exported
    impl.registerMethod(fn);
    impl.registerEntity(fn);
  };

  const visit = (expr: Expr | undefined, exported = false) => {
    if (!expr) return;
    if (expr.isFn()) {
      register(expr, exported);
      return;
    }
    if (expr.isBlock()) {
      expr.body.forEach((e: Expr) => visit(e, exported));
      return;
    }
    if (expr.isCall() || expr.isList()) {
      const isExportLike = expr.calls("export") || expr.calls("pub");
      expr.argsArray().forEach((a: Expr) => visit(a, exported || isExportLike));
      return;
    }
  };

  visit(impl.body.value);
};

const getTargetType = (impl: Implementation): ObjectType | undefined => {
  const expr = impl.targetTypeExpr.value;
  const type = expr.isIdentifier()
    ? expr.resolve()
    : expr.isCall()
    ? expr.fnName.resolve()
    : undefined;

  if (!type || !type.isObjectType()) return;

  if (type.typeParameters?.length && expr.isCall()) {
    const obj = resolveObjectType(type, expr);
    // Object fully resolved to non-generic version i.e. `Vec<i32>`
    if (!obj.typeParameters?.length) return obj;
  }

  // Generic impl with generic target type i.e. `impl<T> for Vec<T>`
  if (!implIsCompatible(impl, type)) return undefined;

  return type;
};

const getTrait = (impl: Implementation): TraitType | undefined => {
  const expr = impl.traitExpr.value;
  if (!expr) return;
  impl.traitExpr.value = resolveTypeExpr(expr);
  const type = getExprType(impl.traitExpr.value);
  if (!type || !type.isTrait()) return;
  return type;
};

export const implIsCompatible = (
  impl: Implementation,
  obj: ObjectType
): boolean => {
  if (!impl.typeParams.length && !obj.typeParameters?.length) return true;

  // For now, only handles generic impls with no constraints that match the type arg length of the target type.
  if (impl.typeParams.length === obj.typeParameters?.length) return true; // impl<T> for Vec<T>
  if (impl.typeParams.length === obj.appliedTypeArgs?.length) return true; // impl<T> for Vec<i32>

  return false;
};

const resolveDefaultTraitMethods = (impl: Implementation): void => {
  if (!impl.trait) return;
  impl.trait.methods
    .toArray()
    .filter((m) => !!m.body)
    .forEach((m) => {
      const existing = impl.resolveFns(m.name.value);
      const clone = resolveFn(m.clone(impl));

      if (
        !existing.length ||
        !existing.some((fn) =>
          typesAreCompatible(fn.getType(), clone.getType())
        )
      ) {
        impl.registerMethod(clone);
        impl.registerExport(clone);
        return;
      }
    });

  // All methods of a trait implementation are exported
  impl.methods.forEach((m) => impl.registerExport(m));
};
