import {
  Type,
  UnionType,
  IntersectionType,
  TupleType,
  FixedArrayType,
  FnType,
  ObjectType,
  voydBaseObject,
} from "../../syntax-objects/types.js";
import { TraitType } from "../../syntax-objects/types/trait.js";

export type TypeKeyState = {
  memo: Map<Type, string>;
  stack: Map<Type, number>;
};

export const createTypeKeyState = (): TypeKeyState => ({
  memo: new Map<Type, string>(),
  stack: new Map<Type, number>(),
});

export const resetTypeKeyState = (state: TypeKeyState): TypeKeyState => {
  state.memo.clear();
  state.stack.clear();
  return state;
};

export const unwrapAlias = (type?: Type | null): Type | undefined => {
  const seen = new Set<Type>();
  let current: Type | undefined | null = type;
  while (current?.isTypeAlias?.()) {
    if (!current.type || seen.has(current)) return undefined;
    seen.add(current);
    current = current.type;
  }
  return current ?? undefined;
};

export const typeKey = (type: Type, state: TypeKeyState): string => {
  const cached = state.memo.get(type);
  if (cached) return cached;

  const active = state.stack.get(type);
  if (active !== undefined) return `cycle:${active}`;

  const index = state.stack.size;
  state.stack.set(type, index);

  let key: string;

  if (type.isTypeAlias()) {
    const target = unwrapAlias(type);
    key = target ? typeKey(target, state) : `alias:${type.id}`;
  } else if (type.isPrimitiveType()) {
    key = `prim:${type.name.value}`;
  } else if (type.isSelfType()) {
    key = "self";
  } else if (type.isUnionType()) {
    const seen = new Set<string>();
    const parts = type.types
      .map((child) => typeKey(child, state))
      .filter((part) => {
        if (seen.has(part)) return false;
        seen.add(part);
        return true;
      })
      .sort();
    key = `union:[${parts.join("|")}]`;
  } else if (type.isIntersectionType()) {
    const parts = new Set<string>();
    if (type.nominalType)
      parts.add(`nom:${typeKey(type.nominalType, state)}`);
    if (type.structuralType)
      parts.add(`str:${typeKey(type.structuralType, state)}`);
    if (parts.size === 0) parts.add("empty");
    const ordered = Array.from(parts).sort();
    key = `intersection:[${ordered.join("|")}]`;
  } else if (type.isTupleType()) {
    const entries = type.value.map((child) => typeKey(child, state));
    key = `tuple:[${entries.join(",")}]`;
  } else if (type.isFixedArrayType()) {
    key = `fixed:${type.elemType ? typeKey(type.elemType, state) : "?"}`;
  } else if (type.isFnType()) {
    const params = type.parameters.map((param) => {
      const opt = param.isOptional ? "opt" : "req";
      const label = param.label ? param.label.value : "";
      const paramType = param.type ? typeKey(param.type, state) : "?";
      return `${opt}:${label}:${paramType}`;
    });
    const ret = type.returnType ? typeKey(type.returnType, state) : "void";
    key = `fn(${params.join(",")})=>${ret}`;
  } else if (type.isObjectType()) {
    if (type.genericParent) {
      const parentId = type.genericParent.id;
      const args = (type.appliedTypeArgs ?? []).map((arg) => {
        const target = unwrapAlias(arg) ?? arg;
        return target ? typeKey(target, state) : `alias:${arg.id}`;
      });
      key = `obj-gen:${parentId}<${args.join(",")}>`;
    } else if (type.isStructural) {
      const fieldKeys = type.fields
        .map((field) =>
          `${field.name}:${field.type ? typeKey(field.type, state) : "?"}`
        )
        .sort();
      const parentKey = type.parentObjType
        ? typeKey(type.parentObjType, state)
        : "base";
      key = `obj-struct:${parentKey}|{${fieldKeys.join(",")}}`;
    } else {
      key = `obj:${type.id}`;
    }
  } else if (type.isTraitType()) {
    if (type.genericParent) {
      const parentId = type.genericParent.id;
      const args = (type.appliedTypeArgs ?? []).map((arg) => {
        const target = unwrapAlias(arg) ?? arg;
        return target ? typeKey(target, state) : `alias:${arg.id}`;
      });
      key = `trait-gen:${parentId}<${args.join(",")}>`;
    } else {
      key = `trait:${type.id}`;
    }
  } else {
    const fallback = type as Type;
    key = `type:${fallback.id}`;
  }

  state.stack.delete(type);
  state.memo.set(type, key);
  return key;
};

export class CanonicalTypeTable {
  #table = new Map<string, Type>();

  get(key: string): Type | undefined {
    return this.#table.get(key);
  }

  insert(key: string, type: Type): void {
    if (!this.#table.has(key)) {
      this.#table.set(key, type);
    }
  }

  clear(): void {
    this.#table.clear();
  }
}

const globalTable = new CanonicalTypeTable();
const globalKeyState = createTypeKeyState();

export const getGlobalCanonicalTypeTable = (): CanonicalTypeTable => globalTable;

export const getGlobalTypeKeyState = (): TypeKeyState => globalKeyState;

export const resetGlobalCanonicalTypeState = (): void => {
  globalTable.clear();
  resetTypeKeyState(globalKeyState);
};

export const mergeTypeMetadata = (source: Type, target: Type): Type => {
  if (source === target) return target;

  if (source.isObjectType() && target.isObjectType()) {
    if (source.typesResolved && !target.typesResolved) target.typesResolved = true;

    if (source.genericInstances?.length) {
      const seen = new Set(target.genericInstances ?? []);
      source.genericInstances.forEach((inst) => {
        if (seen.has(inst)) return;
        if (!target.genericInstances) target.genericInstances = [];
        target.genericInstances.push(inst);
        seen.add(inst);
      });
    }

    if (source.implementations?.length) {
      const seen = new Set(target.implementations);
      source.implementations.forEach((impl) => {
        if (seen.has(impl)) return;
        target.implementations.push(impl);
        seen.add(impl);
      });
    }
  } else if (source.isTraitType() && target.isTraitType()) {
    if (source.typesResolved && !target.typesResolved) target.typesResolved = true;

    if (source.genericInstances?.length) {
      const seen = new Set(target.genericInstances ?? []);
      source.genericInstances.forEach((inst) => {
        if (seen.has(inst)) return;
        if (!target.genericInstances) target.genericInstances = [];
        target.genericInstances.push(inst);
        seen.add(inst);
      });
    }

    if (source.implementations?.length) {
      const seen = new Set(target.implementations);
      source.implementations.forEach((impl) => {
        if (seen.has(impl)) return;
        target.implementations.push(impl);
        seen.add(impl);
      });
    }
  } else if (source.isUnionType() && target.isUnionType()) {
    target.resolutionPhase = Math.max(
      target.resolutionPhase ?? 0,
      source.resolutionPhase ?? 0
    );
  } else if (source.isTypeAlias() && target.isTypeAlias()) {
    target.resolutionPhase = Math.max(target.resolutionPhase, source.resolutionPhase);
    if (!target.type && source.type) target.type = source.type;
  }

  return target;
};

export const isCanonicalSingleton = (type: Type): boolean => {
  if (type === voydBaseObject) return true;
  return type.isPrimitiveType() || type.isSelfType();
};
