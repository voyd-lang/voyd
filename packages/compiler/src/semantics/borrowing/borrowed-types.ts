import type { TypeId } from "../ids.js";
import type { TypingResult } from "../typing/types.js";
import type { PlaceProjection } from "./model.js";

export type BorrowedTypeEntry = {
  path: readonly PlaceProjection[];
  inner: TypeId;
};

const borrowedTypeEntriesByTyping = new WeakMap<
  TypingResult,
  Map<TypeId, readonly BorrowedTypeEntry[]>
>();

export const borrowedTypeEntriesInType = (
  type: TypeId,
  typing: TypingResult,
  prefix: readonly PlaceProjection[] = [],
  active = new Set<TypeId>(),
): readonly BorrowedTypeEntry[] => {
  const cacheable = prefix.length === 0 && active.size === 0;
  const cache =
    borrowedTypeEntriesByTyping.get(typing) ??
    new Map<TypeId, readonly BorrowedTypeEntry[]>();
  if (!borrowedTypeEntriesByTyping.has(typing)) {
    borrowedTypeEntriesByTyping.set(typing, cache);
  }
  const cached = cacheable ? cache.get(type) : undefined;
  if (cached) {
    return cached;
  }
  if (active.has(type)) {
    return [];
  }
  active.add(type);

  const descriptor = typing.arena.get(type);
  const entries = (() => {
    if (descriptor.kind === "borrowed") {
      return [
        { path: prefix, inner: descriptor.inner },
        ...(typeContainsBorrowed(descriptor.inner, typing)
          ? borrowedTypeEntriesInType(
              descriptor.inner,
              typing,
              prefix,
              new Set(active),
            )
          : []),
      ];
    }
    if (descriptor.kind === "recursive") {
      return typeContainsBorrowed(descriptor.body, typing)
        ? borrowedTypeEntriesInType(descriptor.body, typing, prefix, active)
        : [];
    }
    if (descriptor.kind === "union") {
      return descriptor.members.flatMap((member) =>
        typeContainsBorrowed(member, typing)
          ? borrowedTypeEntriesInType(member, typing, prefix, new Set(active))
          : [],
      );
    }
    if (descriptor.kind === "intersection") {
      return [descriptor.nominal, descriptor.structural].flatMap((member) =>
        typeof member === "number" && typeContainsBorrowed(member, typing)
          ? borrowedTypeEntriesInType(member, typing, prefix, new Set(active))
          : [],
      );
    }
    if (
      descriptor.kind === "nominal-object" ||
      descriptor.kind === "value-object"
    ) {
      const object = typing.objectsByNominal.get(type);
      return (
        object?.fields.flatMap((field) =>
          typeContainsBorrowed(field.type, typing)
            ? borrowedTypeEntriesInType(
                field.type,
                typing,
                [
                  ...prefix,
                  Number.isInteger(Number(field.name))
                    ? { kind: "tuple", index: Number(field.name) }
                    : { kind: "field", name: field.name },
                ],
                new Set(active),
              )
            : [],
        ) ?? []
      );
    }
    if (descriptor.kind === "structural-object") {
      return descriptor.fields.flatMap((field) =>
        typeContainsBorrowed(field.type, typing)
          ? borrowedTypeEntriesInType(
              field.type,
              typing,
              [
                ...prefix,
                Number.isInteger(Number(field.name))
                  ? { kind: "tuple", index: Number(field.name) }
                  : { kind: "field", name: field.name },
              ],
              new Set(active),
            )
          : [],
      );
    }
    if (descriptor.kind === "fixed-array") {
      return typeContainsBorrowed(descriptor.element, typing)
        ? borrowedTypeEntriesInType(
            descriptor.element,
            typing,
            [...prefix, { kind: "index", stable: false }],
            active,
          )
        : [];
    }
    return [];
  })();

  active.delete(type);
  const unique = Array.from(
    new Map(
      entries.map(
        (entry) => [JSON.stringify([entry.path, entry.inner]), entry] as const,
      ),
    ).values(),
  );
  if (cacheable) {
    cache.set(type, unique);
  }
  return unique;
};

export const borrowedPathsInType = (
  type: TypeId,
  typing: TypingResult,
): readonly (readonly PlaceProjection[])[] =>
  Array.from(
    new Map(
      borrowedTypeEntriesInType(type, typing).map((entry) => [
        JSON.stringify(entry.path),
        entry.path,
      ]),
    ).values(),
  );

const typeParameterPathsByTyping = new WeakMap<
  TypingResult,
  Map<TypeId, readonly (readonly PlaceProjection[])[]>
>();
const containsTypeParameterByTyping = new WeakMap<
  TypingResult,
  Map<TypeId, boolean>
>();

export const typeParameterPathsInType = (
  type: TypeId,
  typing: TypingResult,
): readonly (readonly PlaceProjection[])[] => {
  const cache =
    typeParameterPathsByTyping.get(typing) ??
    new Map<TypeId, readonly (readonly PlaceProjection[])[]>();
  if (!typeParameterPathsByTyping.has(typing)) {
    typeParameterPathsByTyping.set(typing, cache);
  }
  const cached = cache.get(type);
  if (cached) {
    return cached;
  }

  const containsCache =
    containsTypeParameterByTyping.get(typing) ?? new Map<TypeId, boolean>();
  if (!containsTypeParameterByTyping.has(typing)) {
    containsTypeParameterByTyping.set(typing, containsCache);
  }
  const childTypes = (current: TypeId): readonly TypeId[] => {
    const descriptor = typing.arena.get(current);
    if (descriptor.kind === "borrowed") {
      return [descriptor.inner];
    }
    if (descriptor.kind === "recursive") {
      return [descriptor.body];
    }
    if (descriptor.kind === "union") {
      return descriptor.members;
    }
    if (descriptor.kind === "intersection") {
      return [descriptor.nominal, descriptor.structural].filter(
        (member): member is TypeId => typeof member === "number",
      );
    }
    const fields =
      descriptor.kind === "structural-object"
        ? descriptor.fields
        : descriptor.kind === "nominal-object" ||
            descriptor.kind === "value-object"
          ? typing.objectsByNominal.get(current)?.fields
          : undefined;
    if (fields) {
      return fields.map((field) => field.type);
    }
    return descriptor.kind === "fixed-array" ? [descriptor.element] : [];
  };
  const containsTypeParameter = (current: TypeId): boolean => {
    const cachedContains = containsCache.get(current);
    if (cachedContains !== undefined) {
      return cachedContains;
    }
    const pending = [current];
    const visited = new Set<TypeId>();
    const predecessors = new Map<TypeId, Set<TypeId>>();
    let positive: TypeId | undefined;
    while (pending.length > 0) {
      const candidate = pending.pop()!;
      if (visited.has(candidate)) {
        continue;
      }
      const known = containsCache.get(candidate);
      if (known === true) {
        positive = candidate;
        break;
      }
      if (known === false) {
        continue;
      }
      visited.add(candidate);
      const descriptor = typing.arena.get(candidate);
      if (descriptor.kind === "type-param-ref") {
        positive = candidate;
        break;
      }
      childTypes(candidate).forEach((child) => {
        const parents = predecessors.get(child) ?? new Set<TypeId>();
        parents.add(candidate);
        predecessors.set(child, parents);
        pending.push(child);
      });
    }
    if (positive !== undefined) {
      const positiveAncestors = [positive];
      const marked = new Set<TypeId>();
      while (positiveAncestors.length > 0) {
        const candidate = positiveAncestors.pop()!;
        if (marked.has(candidate)) {
          continue;
        }
        marked.add(candidate);
        containsCache.set(candidate, true);
        predecessors
          .get(candidate)
          ?.forEach((parent) => positiveAncestors.push(parent));
      }
      return true;
    }
    visited.forEach((candidate) => containsCache.set(candidate, false));
    return false;
  };

  const descriptor = typing.arena.get(type);
  const fields =
    descriptor.kind === "structural-object"
      ? descriptor.fields
      : descriptor.kind === "nominal-object" ||
          descriptor.kind === "value-object"
        ? typing.objectsByNominal.get(type)?.fields
        : undefined;
  const paths = fields
    ? fields.flatMap((field) => {
        if (!containsTypeParameter(field.type)) {
          return [];
        }
        return [
          [
            Number.isInteger(Number(field.name))
              ? ({ kind: "tuple", index: Number(field.name) } as const)
              : ({ kind: "field", name: field.name } as const),
          ],
        ];
      })
    : descriptor.kind === "fixed-array" &&
        containsTypeParameter(descriptor.element)
      ? [[{ kind: "index", stable: false } as const]]
      : containsTypeParameter(type)
        ? [[]]
        : [];
  cache.set(type, paths);
  return paths;
};

const containsBorrowedCache = new WeakMap<TypingResult, Map<TypeId, boolean>>();

export const typeContainsBorrowed = (
  type: TypeId,
  typing: TypingResult,
): boolean => {
  const cache = containsBorrowedCache.get(typing) ?? new Map<TypeId, boolean>();
  if (!containsBorrowedCache.has(typing)) {
    containsBorrowedCache.set(typing, cache);
  }
  const cached = cache.get(type);
  if (cached !== undefined) {
    return cached;
  }
  const childTypes = (current: TypeId): readonly TypeId[] => {
    const descriptor = typing.arena.get(current);
    if (descriptor.kind === "recursive") {
      return [descriptor.body];
    }
    if (descriptor.kind === "union") {
      return descriptor.members;
    }
    if (descriptor.kind === "intersection") {
      return [descriptor.nominal, descriptor.structural].filter(
        (member): member is TypeId => typeof member === "number",
      );
    }
    if (
      descriptor.kind === "nominal-object" ||
      descriptor.kind === "value-object"
    ) {
      return (
        typing.objectsByNominal
          .get(current)
          ?.fields.map((field) => field.type) ?? []
      );
    }
    if (descriptor.kind === "structural-object") {
      return descriptor.fields.map((field) => field.type);
    }
    return descriptor.kind === "fixed-array" ? [descriptor.element] : [];
  };
  const pending = [type];
  const visited = new Set<TypeId>();
  const predecessors = new Map<TypeId, Set<TypeId>>();
  let positive: TypeId | undefined;
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (visited.has(current)) {
      continue;
    }
    const known = cache.get(current);
    if (known === true) {
      positive = current;
      break;
    }
    if (known === false) {
      continue;
    }
    visited.add(current);
    if (typing.arena.get(current).kind === "borrowed") {
      positive = current;
      break;
    }
    childTypes(current).forEach((child) => {
      const parents = predecessors.get(child) ?? new Set<TypeId>();
      parents.add(current);
      predecessors.set(child, parents);
      pending.push(child);
    });
  }
  if (positive !== undefined) {
    const positiveAncestors = [positive];
    const marked = new Set<TypeId>();
    while (positiveAncestors.length > 0) {
      const current = positiveAncestors.pop()!;
      if (marked.has(current)) {
        continue;
      }
      marked.add(current);
      cache.set(current, true);
      predecessors
        .get(current)
        ?.forEach((parent) => positiveAncestors.push(parent));
    }
    return true;
  }
  visited.forEach((current) => cache.set(current, false));
  return false;
};
