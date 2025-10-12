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
import { Implementation } from "../../syntax-objects/implementation.js";
import { Fn } from "../../syntax-objects/fn.js";

export type CanonicalTypeDedupeEvent = {
  fingerprint: string;
  canonical: Type;
  reused: Type;
};

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

type FingerprintFn = (type: Type) => string;

type CanonicalTypeTableOptions = {
  fingerprint?: FingerprintFn;
  recordEvents?: boolean;
  onDedupe?: (event: CanonicalTypeDedupeEvent) => void;
};

export class CanonicalTypeTable {
  #cache = new Map<Type, Type>();
  #byFingerprint = new Map<string, Type>();
  #inProgress = new Set<Type>();
  #pending = new Set<Type>();
  #dedupeLog: CanonicalTypeDedupeEvent[] = [];
  #drainingPending = false;
  #fingerprint: FingerprintFn;
  #recordEvents: boolean;
  #onDedupe?: (event: CanonicalTypeDedupeEvent) => void;

  constructor(
    fingerprintOrOptions: FingerprintFn | CanonicalTypeTableOptions = typeKey
  ) {
    if (typeof fingerprintOrOptions === "function") {
      this.#fingerprint = fingerprintOrOptions;
      this.#recordEvents = true;
      return;
    }

    this.#fingerprint = fingerprintOrOptions.fingerprint ?? typeKey;
    this.#recordEvents = fingerprintOrOptions.recordEvents ?? true;
    this.#onDedupe = fingerprintOrOptions.onDedupe;
  }

  canonicalize<T extends Type | undefined>(type: T): T {
    if (!type) return type;
    return this.#canonicalize(type) as T;
  }

  getCanonical(type: Type): Type {
    const snapshot = canonicalType(type);
    const key = this.#fingerprint(snapshot);
    return this.#byFingerprint.get(key) ?? type;
  }

  getDedupeEvents(): CanonicalTypeDedupeEvent[] {
    return [...this.#dedupeLog];
  }

  clearDedupeEvents(): void {
    this.#dedupeLog = [];
  }

  #canonicalize(type: Type): Type {
    const cached = this.#cache.get(type);
    if (cached) {
      if (this.#pending.has(type) && !this.#inProgress.has(type)) {
        return this.#finalizePending(type);
      }
      return cached;
    }

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
        this.#flushPending();
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
      obj.implementations = this.#mergeImplementationLists(
        obj.implementations ?? [],
        []
      );
      return this.#register(obj);
    }

    if ((type as TraitType).isTraitType?.()) {
      const trait = type as TraitType;
      if (trait.appliedTypeArgs?.length) {
        trait.appliedTypeArgs = trait.appliedTypeArgs.map((arg) =>
          this.#canonicalize(arg)
        );
      }
      trait.implementations = this.#mergeImplementationLists(
        trait.implementations ?? [],
        []
      );
      return this.#register(trait);
    }

    const canonical = this.#register(type);
    this.#inProgress.delete(type);
    return canonical;
  }

  #register<T extends Type>(type: T): T {
    if (this.#shouldDefer(type)) {
      this.#defer(type);
      return type;
    }

    const canonical = this.#finalize(type);
    this.#flushPending();
    return canonical as T;
  }

  #finalizePending(type: Type): Type {
    if (this.#shouldDefer(type)) return type;
    const canonical = this.#finalize(type);
    this.#flushPending();
    return canonical;
  }

  #finalize<T extends Type>(type: T): T {
    const snapshot = canonicalType(type);
    const key = this.#fingerprint(snapshot);
    const existing = this.#byFingerprint.get(key);
    if (existing) {
      this.#assertCanonicalReady(existing, "reuse");
      this.#copyMetadata(existing, type);
      if ((existing as UnionType).isUnionType?.() && (type as UnionType).isUnionType?.()) {
        this.#repointAliasToCanonical(type as UnionType, existing as UnionType);
      }
      this.#cache.set(type, existing);
      this.#inProgress.delete(type);
      if (this.#pending.has(type)) this.#pending.delete(type);
      this.#recordDedupe({ fingerprint: key, canonical: existing, reused: type });
      return existing as T;
    }

    this.#byFingerprint.set(key, type);
    this.#cache.set(type, type);
    this.#inProgress.delete(type);
    if (this.#pending.has(type)) this.#pending.delete(type);
    return type;
  }

  #recordDedupe(event: CanonicalTypeDedupeEvent): void {
    if (this.#recordEvents) {
      this.#dedupeLog = [...this.#dedupeLog, event];
    }
    if (this.#onDedupe) this.#onDedupe(event);
  }

  #defer(type: Type): void {
    this.#pending.add(type);
    this.#cache.set(type, type);
    this.#inProgress.delete(type);
  }

  #flushPending(): void {
    if (this.#drainingPending) return;
    if (!this.#pending.size) return;
    this.#drainingPending = true;
    try {
      let progressed = true;
      while (progressed) {
        progressed = false;
        const pending = Array.from(this.#pending);
        pending.forEach((candidate) => {
          if (this.#shouldDefer(candidate)) return;
          this.#pending.delete(candidate);
          this.#finalize(candidate);
          progressed = true;
        });
      }
    } finally {
      this.#drainingPending = false;
    }
  }

  #shouldDefer(type: Type): boolean {
    const children = this.#collectChildTypes(type);
    return children.some((child) => {
      if (!child) return false;
      if (child === type) return false;
      if (this.#inProgress.has(child)) return true;
      return false;
    });
  }

  #collectChildTypes(type: Type): Type[] {
    if ((type as UnionType).isUnionType?.()) {
      return (type as UnionType).types;
    }

    if ((type as IntersectionType).isIntersectionType?.()) {
      const inter = type as IntersectionType;
      const result: Type[] = [];
      if (inter.nominalType) result.push(inter.nominalType);
      if (inter.structuralType) result.push(inter.structuralType);
      return result;
    }

    if ((type as TupleType).isTupleType?.()) {
      return [...(type as TupleType).value];
    }

    if ((type as FixedArrayType).isFixedArrayType?.()) {
      const arr = type as FixedArrayType;
      return arr.elemType ? [arr.elemType] : [];
    }

    if ((type as FnType).isFnType?.()) {
      const fn = type as FnType;
      const params = fn.parameters
        .flatMap((param) =>
          [param.type, param.originalType].filter(
            (child): child is Type => !!child
          )
        )
        .filter((child): child is Type => !!child);
      return fn.returnType ? [fn.returnType, ...params] : [...params];
    }

    if ((type as ObjectType).isObjectType?.()) {
      const obj = type as ObjectType;
      const appliedArgs = obj.appliedTypeArgs ?? [];
      const fieldTypes = obj.fields
        .map((field) => field.type)
        .filter((child): child is Type => !!child);
      const genericInstances = obj.genericInstances ?? [];
      const parent = obj.parentObjType ? [obj.parentObjType] : [];
      return [...appliedArgs, ...fieldTypes, ...parent, ...genericInstances];
    }

    if ((type as TraitType).isTraitType?.()) {
      const trait = type as TraitType;
      const appliedArgs = trait.appliedTypeArgs ?? [];
      const genericInstances = trait.genericInstances ?? [];
      return [...appliedArgs, ...genericInstances];
    }

    return [];
  }

  #assertCanonicalReady(type: Type, phase: "register" | "reuse") {
    if (phase !== "reuse") return;

    if ((type as ObjectType).isObjectType?.()) {
      const obj = type as ObjectType;
      if (
        !obj.isStructural &&
        !obj.typeParameters?.length &&
        obj.typesResolved !== true
      ) {
        throw new Error(
          `[CanonicalTypeTable] attempted to ${phase} unresolved object type ${obj.name.toString()}`
        );
      }
      if (!obj.isStructural && !obj.lexicon) {
        throw new Error(
          `[CanonicalTypeTable] object type ${obj.name.toString()} missing lexicon during ${phase}`
        );
      }
    }

    if ((type as TraitType).isTraitType?.()) {
      const trait = type as TraitType;
      if (!trait.typeParameters?.length && trait.typesResolved !== true) {
        throw new Error(
          `[CanonicalTypeTable] attempted to ${phase} unresolved trait ${trait.name.toString()}`
        );
      }
      if (!trait.lexicon) {
        throw new Error(
          `[CanonicalTypeTable] trait ${trait.name.toString()} missing lexicon during ${phase}`
        );
      }
    }
  }

  #copyMetadata(target: Type, source: Type): void {
    if ((target as ObjectType).isObjectType?.() && (source as ObjectType).isObjectType?.()) {
      this.#mergeObjectMetadata(target as ObjectType, source as ObjectType);
      return;
    }

    if ((target as TraitType).isTraitType?.() && (source as TraitType).isTraitType?.()) {
      this.#mergeTraitMetadata(target as TraitType, source as TraitType);
    }
  }

  #repointAliasToCanonical(reused: UnionType, canonical: UnionType): void {
    const aliasParent = (reused.parent as TypeAlias | undefined)?.isTypeAlias?.()
      ? (reused.parent as TypeAlias)
      : undefined;
    if (!aliasParent) return;
    if (aliasParent.type === reused) {
      aliasParent.type = canonical;
    }
  }

  #shouldReplaceAppliedArg(current?: Type, incoming?: Type): boolean {
    if (!incoming) return false;
    if (!current) return true;
    const currentAlias = (current as TypeAlias).isTypeAlias?.();
    const incomingAlias = (incoming as TypeAlias).isTypeAlias?.();
    if (currentAlias && !incomingAlias) return true;
    return false;
  }

  #implementationKey(impl: Implementation): string {
    if (impl.trait) return `trait:${impl.trait.id}`;
    return `inherent:${impl.syntaxId}`;
  }

  #mergeImplementationLists(
    baseline: Implementation[] = [],
    incoming: Implementation[] = []
  ): Implementation[] {
    const merged: Implementation[] = [];
    const seen = new Map<string, Implementation>();
    const insert = (impl: Implementation) => {
      const key = this.#implementationKey(impl);
      const existing = seen.get(key);
      if (existing) {
        this.#mergeImplementationMetadata(existing, impl);
        return;
      }
      seen.set(key, impl);
      merged.push(impl);
    };
    baseline.forEach(insert);
    incoming.forEach(insert);
    return merged;
  }

  #mergeImplementationMetadata(target: Implementation, source: Implementation): void {
    source.methods.forEach((method) => {
      const existing = target.methods.find((m) => m.name.is(method.name));
      if (existing) {
        this.#mergeFnMetadata(existing, method);
        return;
      }
      target.registerMethod(method);
    });
    source.exports.forEach((exp) => {
      if (target.exports.some((fn) => fn.id === exp.id)) return;
      target.registerExport(exp);
    });
  }

  #mergeFnMetadata(target: Fn, source: Fn): void {
    const targetInstances = target.genericInstances ?? [];
    const incoming = source.genericInstances ?? [];
    if (!incoming?.length) return;
    const seen = new Set(targetInstances);
    incoming.forEach((inst) => {
      if (seen.has(inst)) return;
      seen.add(inst);
      target.registerGenericInstance(inst);
    });
  }

  #mergeObjectMetadata(target: ObjectType, source: ObjectType): void {
    if (source.typesResolved === true && target.typesResolved !== true) {
      target.typesResolved = true;
    }

    if (
      source.binaryenType !== undefined &&
      target.binaryenType === undefined
    ) {
      target.binaryenType = source.binaryenType;
    }

    if (source.appliedTypeArgs?.length) {
      const merged = target.appliedTypeArgs ? [...target.appliedTypeArgs] : [];
      source.appliedTypeArgs.forEach((arg, index) => {
        if (this.#shouldReplaceAppliedArg(merged[index], arg)) {
          merged[index] = arg;
        } else if (!merged[index]) {
          merged[index] = arg;
        }
      });
      if (merged.length) target.appliedTypeArgs = merged;
    }

    if (source.genericParent && !target.genericParent) {
      target.genericParent = source.genericParent;
    }

    if (source.genericInstances?.length) {
      const existing = new Set(target.genericInstances ?? []);
      const merged = target.genericInstances ? [...target.genericInstances] : [];
      source.genericInstances.forEach((inst) => {
        if (existing.has(inst)) return;
        existing.add(inst);
        merged.push(inst);
      });
      if (merged.length) target.genericInstances = merged;
    }

    target.implementations = this.#mergeImplementationLists(
      target.implementations ?? [],
      source.implementations ?? []
    );
  }

  #mergeTraitMetadata(target: TraitType, source: TraitType): void {
    if (source.typesResolved === true && target.typesResolved !== true) {
      target.typesResolved = true;
    }

    if (source.appliedTypeArgs?.length) {
      const merged = target.appliedTypeArgs ? [...target.appliedTypeArgs] : [];
      source.appliedTypeArgs.forEach((arg, index) => {
        if (this.#shouldReplaceAppliedArg(merged[index], arg)) {
          merged[index] = arg;
        } else if (!merged[index]) {
          merged[index] = arg;
        }
      });
      if (merged.length) target.appliedTypeArgs = merged;
    }

    if (source.genericParent && !target.genericParent) {
      target.genericParent = source.genericParent;
    }

    if (source.genericInstances?.length) {
      const existing = new Set(target.genericInstances ?? []);
      const merged = target.genericInstances ? [...target.genericInstances] : [];
      source.genericInstances.forEach((inst) => {
        if (existing.has(inst)) return;
        existing.add(inst);
        merged.push(inst);
      });
      if (merged.length) target.genericInstances = merged;
    }

    target.implementations = this.#mergeImplementationLists(
      target.implementations ?? [],
      source.implementations ?? []
    );
  }
}

export default CanonicalTypeTable;
