import {
  FixedArrayType,
  FnType,
  IntersectionType,
  ObjectType,
  TupleType,
  Type,
  TypeAlias,
  UnionType,
  VoydRefType,
} from "../../syntax-objects/types.js";
import { typeKey } from "./type-key.js";
import canonicalType from "./canonicalize.js";
import { TraitType } from "../../syntax-objects/types/trait.js";

const dedupe = <T>(values: T[]): T[] => {
  const seen = new Set<T>();
  const result: T[] = [];
  values.forEach((value) => {
    if (seen.has(value)) return;
    seen.add(value);
    result.push(value);
  });
  return result;
};

export class CanonicalTypeTable {
  #cache = new Map<Type, Type>();
  #byFingerprint = new Map<string, Type>();
  #inProgress = new Set<Type>();

  constructor(private readonly fingerprint = typeKey) {}

  canonicalize<T extends Type | undefined>(type: T): T {
    if (!type) return type;
    return this.#canonicalize(type) as T;
  }

  getCanonical(type: Type): Type {
    const snapshot = canonicalType(type);
    const key = this.fingerprint(snapshot);
    return this.#byFingerprint.get(key) ?? type;
  }

  #canonicalize(type: Type): Type {
    const cached = this.#cache.get(type);
    if (cached) return cached;

    if (this.#inProgress.has(type)) {
      if ((type as TypeAlias).isTypeAlias?.()) {
        const alias = type as TypeAlias;
        return alias.type ?? alias;
      }
      return type;
    }
    this.#inProgress.add(type);

    if ((type as TypeAlias).isTypeAlias?.()) {
      const alias = type as TypeAlias;
      const target = alias.type ? this.#canonicalize(alias.type) : undefined;
      if (target) {
        alias.type = target;
        this.#cache.set(alias, target);
        const normalized = this.#canonicalize(target);
        alias.type = normalized;
        this.#cache.set(alias, normalized);
        this.#inProgress.delete(type);
        return normalized;
      }
      this.#cache.set(alias, alias);
      this.#inProgress.delete(type);
      return alias;
    }

    if (type.isPrimitiveType?.() || type.isSelfType?.()) {
      this.#cache.set(type, type);
      this.#inProgress.delete(type);
      return type;
    }

    if ((type as UnionType).isUnionType?.()) {
      const union = type as UnionType;
      const canonicalParts = union.types.map((child) =>
        this.#canonicalize(child)
      ) as VoydRefType[];
      union.types = dedupe(canonicalParts);
      return this.#register(union);
    }

    if ((type as IntersectionType).isIntersectionType?.()) {
      const inter = type as IntersectionType;
      if (inter.nominalType)
        inter.nominalType = this.#canonicalize(inter.nominalType) as ObjectType;
      if (inter.structuralType)
        inter.structuralType = this.#canonicalize(
          inter.structuralType
        ) as ObjectType;
      return this.#register(inter);
    }

    if ((type as TupleType).isTupleType?.()) {
      const tuple = type as TupleType;
      tuple.value = tuple.value.map((entry) => this.#canonicalize(entry));
      return this.#register(tuple);
    }

    if ((type as FixedArrayType).isFixedArrayType?.()) {
      const arr = type as FixedArrayType;
      if (arr.elemType) arr.elemType = this.#canonicalize(arr.elemType);
      return this.#register(arr);
    }

    if ((type as FnType).isFnType?.()) {
      const fn = type as FnType;
      if (fn.returnType) fn.returnType = this.#canonicalize(fn.returnType);
      fn.parameters.forEach((param) => {
        if (param.type) param.type = this.#canonicalize(param.type);
        if (param.originalType)
          param.originalType = this.#canonicalize(param.originalType);
      });
      return this.#register(fn);
    }

    if ((type as ObjectType).isObjectType?.()) {
      const obj = type as ObjectType;
      if (obj.parentObjType)
        obj.parentObjType = this.#canonicalize(obj.parentObjType) as ObjectType;
      if (obj.appliedTypeArgs?.length) {
        obj.appliedTypeArgs = obj.appliedTypeArgs.map((arg) => {
          const canonicalArg = this.#canonicalize(arg);
          if ((canonicalArg as TypeAlias).isTypeAlias?.()) {
            const target = (canonicalArg as TypeAlias).type;
            return target ? this.#canonicalize(target) : canonicalArg;
          }
          return canonicalArg;
        });
      }
      obj.fields.forEach((field) => {
        if (field.type) field.type = this.#canonicalize(field.type);
      });
      return this.#register(obj);
    }

    if ((type as TraitType).isTraitType?.()) {
      const trait = type as TraitType;
      if (trait.appliedTypeArgs?.length) {
        trait.appliedTypeArgs = trait.appliedTypeArgs.map((arg) =>
          this.#canonicalize(arg)
        );
      }
      return this.#register(trait);
    }

    const canonical = this.#register(type);
    this.#inProgress.delete(type);
    return canonical;
  }

  #register<T extends Type>(type: T): T {
    const snapshot = canonicalType(type);
    const key = this.fingerprint(snapshot);
    const existing = this.#byFingerprint.get(key);
    if (existing) {
      this.#cache.set(type, existing);
      this.#inProgress.delete(type);
      return existing as T;
    }

    this.#byFingerprint.set(key, type);
    this.#cache.set(type, type);
    this.#inProgress.delete(type);
    return type;
  }
}

export default CanonicalTypeTable;
