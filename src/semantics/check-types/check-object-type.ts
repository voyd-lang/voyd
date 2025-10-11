import { ObjectType, Type, ObjectField } from "../../syntax-objects/types.js";
import { Implementation } from "../../syntax-objects/implementation.js";
import { typesAreCompatible } from "../resolution/index.js";
import { checkTypes } from "./check-types.js";
import { checkFnTypes } from "./check-fn.js";
import { canonicalType } from "../types/canonicalize.js";
import { typeKey } from "../types/type-key.js";

export const checkObjectType = (obj: ObjectType): ObjectType => {
  if (obj.genericInstances) {
    obj.genericInstances.forEach(checkTypes);
    return obj;
  }

  if (obj.typeParameters) {
    return obj;
  }

  obj.fields.forEach((field: ObjectField) => {
    if (!field.type) {
      throw new Error(
        `Unable to determine type for ${field.typeExpr} at ${field.typeExpr.location}`
      );
    }
  });

  const implementedTraits = new Set<string>();
  obj.implementations.forEach((impl: Implementation) => {
    if (!impl.trait) return;

    if (implementedTraits.has(impl.trait.id)) {
      throw new Error(
        `Trait ${impl.trait.name} implemented multiple times for obj ${obj.name} at ${obj.location}`
      );
    }

    implementedTraits.add(impl.trait.id);
  });

  obj.implementations.forEach(checkImpl);

  if (obj.parentObjExpr) {
    assertValidExtension(obj, obj.parentObjType);
  }

  return obj;
};

export function assertValidExtension(
  child: ObjectType,
  parent?: Type
): asserts parent is ObjectType {
  if (!parent || !parent?.isObjectType()) {
    throw new Error(`Cannot resolve parent for obj ${child.name}`);
  }

  const validExtension = parent.fields.every((field: ObjectField) => {
    const match = child.fields.find((f: ObjectField) => f.name === field.name);
    return match && typesAreCompatible(field.type, match.type);
  });

  if (!validExtension) {
    throw new Error(`${child.name} does not properly extend ${parent.name}`);
  }
}

const checkImpl = (impl: Implementation): Implementation => {
  if (impl.traitExpr.value && !impl.trait) {
    throw new Error(`Unable to resolve trait for impl at ${impl.location}`);
  }
  // Always validate method bodies
  for (const method of impl.methods) {
    checkFnTypes(method);
  }

  if (!impl.trait) return impl;

  for (const method of impl.trait.methods.toArray()) {
    const implMethod = impl.methods.find(
      (fn) => fn.name?.value === method.name?.value
    );
    if (!implMethod) {
      throw new Error(
        `Impl does not implement ${method.name} at ${impl.location}`
      );
    }

    const implType = implMethod.getType();
    const traitType = method.getType();

    const paramsCompatible = traitType.parameters.every((param, idx) => {
      const implParam = implType.parameters[idx]?.type;
      if (!param.type) return !implParam;
      if (param.type.isSelfType()) return true;
      if (!implParam) return false;
      if (typesAreCompatible(implParam, param.type)) return true;
      const canonicalImplParam = canonicalType(implParam);
      const canonicalTraitParam = canonicalType(param.type);
      return (
        typeKey(canonicalImplParam) === typeKey(canonicalTraitParam)
      );
    });

    const returnsCompatible =
      typesAreCompatible(implType.returnType, traitType.returnType) ||
      (implType.returnType &&
        traitType.returnType &&
        typeKey(canonicalType(implType.returnType)) ===
          typeKey(canonicalType(traitType.returnType)));

    if (!paramsCompatible || !returnsCompatible) {
      throw new Error(
        `Impl does not implement ${method.name} at ${impl.location}`
      );
    }
  }

  return impl;
};
