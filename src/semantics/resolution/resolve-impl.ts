import { nop } from "../../syntax-objects/helpers.js";
import { Implementation } from "../../syntax-objects/implementation.js";
import { ObjectType, TypeAlias } from "../../syntax-objects/types.js";
import { getExprType } from "./get-expr-type.js";
import { resolveObjectType } from "./resolve-object-type.js";
import { resolveEntities } from "./resolve-entities.js";
import { resolveTypeExpr } from "./resolve-type-expr.js";
import { Trait } from "../../syntax-objects/trait.js";
import { typesAreCompatible } from "./types-are-compatible.js";
import { resolveFn } from "./resolve-fn.js";

export const resolveImpl = (
  impl: Implementation,
  targetType?: ObjectType
): Implementation => {
  if (impl.typesResolved) return impl;
  targetType = targetType ?? getTargetType(impl);
  impl.targetType = targetType;
  impl.trait = getTrait(impl);

  if (!targetType) return impl;

  if (targetType.appliedTypeArgs) {
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

const getTrait = (impl: Implementation): Trait | undefined => {
  const expr = impl.traitExpr.value;
  const type = expr?.isIdentifier() ? expr.resolve() : undefined;
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
