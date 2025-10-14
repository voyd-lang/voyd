import {
  FixedArrayType,
  FnType,
  IntersectionType,
  ObjectType,
  TupleType,
  Type,
  TypeAlias,
  UnionType,
  PrimitiveType,
  SelfType,
} from "../../syntax-objects/types.js";
import { TraitType } from "../../syntax-objects/types/trait.js";
import canonicalType from "./canonicalize.js";
import { typeKey } from "./type-key.js";

type FingerprintFn = (type: Type) => string;

export type TypeInternerEvent = {
  fingerprint: string;
  canonical: Type;
  reused: Type;
};

export type TypeInternerStats = {
  observed: number;
  canonical: number;
  reused: number;
};

export type TypeInternerOptions = {
  fingerprint?: FingerprintFn;
  recordEvents?: boolean;
};

const dedupeByIdentity = <T>(values: (T | undefined)[]): T[] => {
  const seen = new Set<T>();
  const result: T[] = [];
  values.forEach((value) => {
    if (!value) return;
    if (seen.has(value)) return;
    seen.add(value);
    result.push(value);
  });
  return result;
};

const isPrimitiveOrSelf = (type: Type): boolean =>
  type instanceof PrimitiveType || type instanceof SelfType;

export class TypeInterner {
  #aliases = new WeakMap<Type, Type>();
  #byFingerprint = new Map<string, Type>();
  #fingerprint: FingerprintFn;
  #recordEvents: boolean;
  #events: TypeInternerEvent[] = [];
  #stats: TypeInternerStats = {
    observed: 0,
    canonical: 0,
    reused: 0,
  };

  constructor(options: TypeInternerOptions = {}) {
    this.#fingerprint = options.fingerprint ?? typeKey;
    this.#recordEvents = options.recordEvents ?? false;
  }

  intern<T extends Type | undefined>(type: T): T {
    if (!type) return type;
    if (isPrimitiveOrSelf(type)) return type;
    return this.#resolve(type, new Set()) as T;
  }

  internList(items: Iterable<Type | undefined>): Type[] {
    const result: Type[] = [];
    for (const item of items) {
      const canonical = this.intern(item);
      if (canonical) result.push(canonical);
    }
    return result;
  }

  getCanonicalByFingerprint(key: string): Type | undefined {
    return this.#byFingerprint.get(key);
  }

  getStats(): TypeInternerStats {
    return { ...this.#stats };
  }

  getEvents(): TypeInternerEvent[] {
    return [...this.#events];
  }

  reset(): void {
    this.#aliases = new WeakMap();
    this.#byFingerprint.clear();
    this.#events = [];
    this.#stats = { observed: 0, canonical: 0, reused: 0 };
  }

  #resolve(type: Type, path: Set<Type>): Type {
    if (isPrimitiveOrSelf(type)) return type;

    const cached = this.#aliases.get(type);
    if (cached) return cached;

    if (path.has(type)) return type;

    if (type instanceof TypeAlias && type.type) {
      path.add(type);
      const canonicalTarget = this.#resolve(type.type, path);
      this.#aliases.set(type, canonicalTarget);
      path.delete(type);
      return canonicalTarget;
    }

    path.add(type);
    this.#stats.observed += 1;

    const fingerprint = this.#fingerprint(canonicalType(type));
    const canonical = this.#byFingerprint.get(fingerprint);
    if (canonical) {
      this.#aliases.set(type, canonical);
      this.#stats.reused += 1;
      this.#recordEvent({ fingerprint, canonical, reused: type });
      path.delete(type);
      return canonical;
    }

    this.#byFingerprint.set(fingerprint, type);
    this.#aliases.set(type, type);
    this.#stats.canonical += 1;

    const rewritten = this.#rewriteGraph(type, new Set<Type>(), path);
    path.delete(type);
    return rewritten;
  }

  #rewriteGraph<T extends Type>(
    type: T,
    visited: Set<Type>,
    path: Set<Type>
  ): T {
    if (visited.has(type)) return type;
    visited.add(type);

    if (type instanceof UnionType) {
      const canonicalParts = dedupeByIdentity(
        type.types.map((child) => this.#resolveReference(child, path))
      );
      type.types = canonicalParts as UnionType["types"][number][];
      visited.delete(type);
      return type;
    }

    if (type instanceof IntersectionType) {
      if (type.nominalType) {
        type.nominalType = this.#resolveReference(
          type.nominalType,
          path
        ) as ObjectType;
      }
      if (type.structuralType) {
        type.structuralType = this.#resolveReference(
          type.structuralType,
          path
        ) as ObjectType;
      }
      visited.delete(type);
      return type;
    }

    if (type instanceof TupleType) {
      type.value = type.value.map(
        (entry) => this.#resolveReference(entry, path) ?? entry
      );
      visited.delete(type);
      return type;
    }

    if (type instanceof FixedArrayType) {
      if (type.elemType) {
        type.elemType = this.#resolveReference(type.elemType, path);
      }
      visited.delete(type);
      return type;
    }

    if (type instanceof FnType) {
      if (type.returnType) {
        type.returnType = this.#resolveReference(type.returnType, path);
      }
      type.parameters.forEach((param) => {
        if (param.type) {
          param.type = this.#resolveReference(param.type, path);
        }
        if (param.originalType) {
          param.originalType = this.#resolveReference(param.originalType, path);
        }
      });
      visited.delete(type);
      return type;
    }

    if (type instanceof ObjectType) {
      if (type.parentObjType) {
        const parent = this.#resolveReference(type.parentObjType, path);
        if (parent instanceof ObjectType) {
          type.parentObjType = parent;
        }
      }

      if (type.genericParent) {
        const parent = this.#resolveReference(type.genericParent, path);
        if (parent instanceof ObjectType) {
          type.genericParent = parent;
        }
      }

      if (type.appliedTypeArgs?.length) {
        type.appliedTypeArgs = type.appliedTypeArgs.map((arg) =>
          this.#resolveReference(arg, path)
        );
      }

      type.fields.forEach((field) => {
        if (field.type) {
          field.type = this.#resolveReference(field.type, path);
        }
      });

      if (type.genericInstances?.length) {
        type.genericInstances = dedupeByIdentity(
          type.genericInstances.map((instance) => {
            const canonicalInstance = this.#resolveReference(instance, path);
            return canonicalInstance instanceof ObjectType
              ? canonicalInstance
              : instance;
          })
        );
      }

      visited.delete(type);
      return type;
    }

    if (type instanceof TraitType) {
      if (type.genericParent) {
        const parent = this.#resolveReference(type.genericParent, path);
        if (parent instanceof TraitType) {
          type.genericParent = parent;
        }
      }

      if (type.appliedTypeArgs?.length) {
        type.appliedTypeArgs = type.appliedTypeArgs.map((arg) =>
          this.#resolveReference(arg, path)
        );
      }

      if (type.genericInstances?.length) {
        type.genericInstances = dedupeByIdentity(
          type.genericInstances.map((instance) => {
            const canonicalInstance = this.#resolveReference(instance, path);
            return canonicalInstance instanceof TraitType
              ? canonicalInstance
              : instance;
          })
        );
      }

      visited.delete(type);
      return type;
    }

    visited.delete(type);
    return type;
  }

  #resolveReference(type: Type | undefined, path: Set<Type>): Type | undefined {
    if (!type) return undefined;
    if (isPrimitiveOrSelf(type)) return type;

    if (type instanceof TypeAlias) {
      if (type.type) {
        const resolved = this.#resolve(type.type, path);
        type.type = resolved;
        return resolved;
      }
      return type;
    }

    return this.#resolve(type, path);
  }

  #recordEvent(event: TypeInternerEvent): void {
    if (!this.#recordEvents) return;
    this.#events = [...this.#events, event];
  }
}
