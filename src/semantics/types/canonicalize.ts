import {
  FixedArrayType,
  FnType,
  IntersectionType,
  ObjectType,
  TupleType,
  Type,
  UnionType,
  voydBaseObject,
} from "../../syntax-objects/types.js";
import { TraitType } from "../../syntax-objects/types/trait.js";
import { getExprType } from "../resolution/get-expr-type.js";
import { resolveTypeExpr } from "../resolution/resolve-type-expr.js";
import {
  getGlobalCanonicalTypeTable,
  getGlobalTypeKeyState,
  isCanonicalSingleton,
  mergeTypeMetadata,
  resetTypeKeyState,
  typeKey,
} from "./canonical-registry.js";

const table = getGlobalCanonicalTypeTable();
const keyState = getGlobalTypeKeyState();
const cache = new WeakMap<Type, Type>();
const inProgress = new Set<Type>();

const canonicalizeType = (input?: Type | null): Type | undefined => {
  if (!input) return undefined;

  const cached = cache.get(input);
  if (cached) return cached;

  if (isCanonicalSingleton(input)) {
    cache.set(input, input);
    return input;
  }

  if (input.isTypeAlias?.()) {
    if (inProgress.has(input)) return input;
    inProgress.add(input);
    const resolved = canonicalizeType(input.type);
    if (resolved) input.type = resolved;
    inProgress.delete(input);
    const result = resolved ?? input;
    cache.set(input, result);
    return result;
  }

  if (inProgress.has(input)) return input;
  inProgress.add(input);

  if (input.isUnionType?.()) {
    const unique = new Set<Type>();
    const flattened: Type[] = [];
    const addMember = (candidate?: Type) => {
      if (!candidate) return;
      if (candidate.isUnionType?.()) {
        candidate.types.forEach((nested) => addMember(canonicalizeType(nested)));
        return;
      }
      if (unique.has(candidate)) return;
      unique.add(candidate);
      flattened.push(candidate);
    };
    input.types.forEach((member) => addMember(canonicalizeType(member)));
    (input as UnionType).types = flattened as UnionType["types"];
  } else if (input.isIntersectionType?.()) {
    const nominal = canonicalizeType(input.nominalType);
    input.nominalType = nominal?.isObjectType?.()
      ? (nominal as ObjectType)
      : undefined;
    const structural = canonicalizeType(input.structuralType);
    input.structuralType = structural?.isObjectType?.()
      ? (structural as ObjectType)
      : undefined;
    if (!input.nominalType) {
      const result = input.structuralType ?? input;
      inProgress.delete(input);
      cache.set(input, result);
      return result;
    }
    if (!input.structuralType) {
      const result = input.nominalType;
      inProgress.delete(input);
      cache.set(input, result);
      return result;
    }
  } else if (input.isFnType?.()) {
    input.parameters.forEach((param, index) => {
      const source = input.parameters[index];
      const paramType =
        source?.type ??
        (source?.typeExpr ? getExprType(resolveTypeExpr(source.typeExpr)) : undefined);
      if (paramType) param.type = canonicalizeType(paramType);
    });
    if (input.returnType) {
      input.returnType = canonicalizeType(input.returnType);
    } else if (input.returnTypeExpr) {
      const resolved = getExprType(resolveTypeExpr(input.returnTypeExpr));
      input.returnType = resolved ? canonicalizeType(resolved) : undefined;
    }
  } else if (input.isObjectType?.()) {
    if (input.appliedTypeArgs) {
      input.appliedTypeArgs = input.appliedTypeArgs.map((arg) => {
        if (arg.isTypeAlias?.()) {
          const resolved = canonicalizeType(arg.type);
          if (resolved) arg.type = resolved;
          return arg;
        }
        const canonicalArg = canonicalizeType(arg);
        return canonicalArg ?? arg;
      });
    }
    if (input.genericParent) {
      const parent = canonicalizeType(input.genericParent);
      input.genericParent = parent?.isObjectType?.()
        ? (parent as ObjectType)
        : input.genericParent;
    }
    if (input.genericInstances) {
      input.genericInstances = input.genericInstances.map((instance) => {
        const canonicalInstance = canonicalizeType(instance);
        return canonicalInstance?.isObjectType?.()
          ? (canonicalInstance as ObjectType)
          : instance;
      });
    }
    if (input.parentObjType) {
      const parentObj = canonicalizeType(input.parentObjType);
      input.parentObjType = parentObj?.isObjectType?.()
        ? (parentObj as ObjectType)
        : input.parentObjType;
    }
  } else if (input.isTraitType?.()) {
    const trait = input as TraitType;
    if (trait.appliedTypeArgs) {
      trait.appliedTypeArgs = trait.appliedTypeArgs.map((arg) => {
        if (arg.isTypeAlias?.()) {
          const resolved = canonicalizeType(arg.type);
          if (resolved) arg.type = resolved;
          return arg;
        }
        const canonicalArg = canonicalizeType(arg);
        return canonicalArg ?? arg;
      });
    }
    if (trait.genericParent) {
      const parent = canonicalizeType(trait.genericParent);
      trait.genericParent = parent?.isTraitType?.()
        ? (parent as TraitType)
        : trait.genericParent;
    }
    if (trait.genericInstances) {
      trait.genericInstances = trait.genericInstances.map((instance) => {
        const canonicalInstance = canonicalizeType(instance);
        return canonicalInstance?.isTraitType?.()
          ? (canonicalInstance as TraitType)
          : instance;
      });
    }
  } else if (input.isTupleType?.()) {
    (input as TupleType).value = (input as TupleType).value
      .map((child) => canonicalizeType(child))
      .filter((child): child is Type => !!child);
  } else if (input.isFixedArrayType?.()) {
    (input as FixedArrayType).elemType = canonicalizeType(
      (input as FixedArrayType).elemType
    );
  }

  inProgress.delete(input);

  const key = typeKey(input, resetTypeKeyState(keyState));
  const existing = table.get(key);
  if (existing) {
    mergeTypeMetadata(input, existing);
    cache.set(input, existing);
    return existing;
  }

  table.insert(key, input);
  cache.set(input, input);
  return input;
};

export const canonicalType = (type: Type): Type => {
  if (type === voydBaseObject) return type;
  const canonical = canonicalizeType(type);
  return canonical ?? type;
};

export default canonicalType;
