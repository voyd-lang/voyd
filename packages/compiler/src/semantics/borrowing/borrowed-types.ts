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
        ...borrowedTypeEntriesInType(
          descriptor.inner,
          typing,
          prefix,
          new Set(active),
        ),
      ];
    }
    if (descriptor.kind === "recursive") {
      return borrowedTypeEntriesInType(descriptor.body, typing, prefix, active);
    }
    if (descriptor.kind === "union") {
      return descriptor.members.flatMap((member) =>
        borrowedTypeEntriesInType(member, typing, prefix, new Set(active)),
      );
    }
    if (descriptor.kind === "intersection") {
      return [descriptor.nominal, descriptor.structural].flatMap((member) =>
        typeof member === "number"
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
          borrowedTypeEntriesInType(
            field.type,
            typing,
            [
              ...prefix,
              Number.isInteger(Number(field.name))
                ? { kind: "tuple", index: Number(field.name) }
                : { kind: "field", name: field.name },
            ],
            new Set(active),
          ),
        ) ?? []
      );
    }
    if (descriptor.kind === "structural-object") {
      return descriptor.fields.flatMap((field) =>
        borrowedTypeEntriesInType(
          field.type,
          typing,
          [
            ...prefix,
            Number.isInteger(Number(field.name))
              ? { kind: "tuple", index: Number(field.name) }
              : { kind: "field", name: field.name },
          ],
          new Set(active),
        ),
      );
    }
    if (descriptor.kind === "fixed-array") {
      return borrowedTypeEntriesInType(
        descriptor.element,
        typing,
        [...prefix, { kind: "index", stable: false }],
        active,
      );
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
  const containsTypeParameter = (
    current: TypeId,
    active = new Set<TypeId>(),
  ): boolean => {
    const cacheable = active.size === 0;
    const cachedContains = cacheable ? containsCache.get(current) : undefined;
    if (cachedContains !== undefined) {
      return cachedContains;
    }
    if (active.has(current)) {
      return false;
    }
    active.add(current);
    const descriptor = typing.arena.get(current);
    const result = (() => {
      if (descriptor.kind === "type-param-ref") {
        return true;
      }
      if (descriptor.kind === "borrowed") {
        return containsTypeParameter(descriptor.inner, active);
      }
      if (descriptor.kind === "recursive") {
        return containsTypeParameter(descriptor.body, active);
      }
      if (descriptor.kind === "union") {
        return descriptor.members.some((member) =>
          containsTypeParameter(member, new Set(active)),
        );
      }
      if (descriptor.kind === "intersection") {
        return [descriptor.nominal, descriptor.structural].some(
          (member) =>
            typeof member === "number" &&
            containsTypeParameter(member, new Set(active)),
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
        return fields.some((field) =>
          containsTypeParameter(field.type, new Set(active)),
        );
      }
      return (
        descriptor.kind === "fixed-array" &&
        containsTypeParameter(descriptor.element, active)
      );
    })();
    active.delete(current);
    if (cacheable) {
      containsCache.set(current, result);
    }
    return result;
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

  const visit = (current: TypeId, active: Set<TypeId>): boolean => {
    const cached = cache.get(current);
    if (cached !== undefined) {
      return cached;
    }
    if (active.has(current)) {
      return false;
    }
    active.add(current);
    const descriptor = typing.arena.get(current);
    const result = (() => {
      if (descriptor.kind === "borrowed") {
        return true;
      }
      if (descriptor.kind === "recursive") {
        return visit(descriptor.body, active);
      }
      if (descriptor.kind === "union") {
        return descriptor.members.some((member) => visit(member, active));
      }
      if (descriptor.kind === "intersection") {
        return [descriptor.nominal, descriptor.structural].some(
          (member) => typeof member === "number" && visit(member, active),
        );
      }
      if (
        descriptor.kind === "nominal-object" ||
        descriptor.kind === "value-object"
      ) {
        return (
          typing.objectsByNominal
            .get(current)
            ?.fields.some((field) => visit(field.type, active)) ?? false
        );
      }
      if (descriptor.kind === "structural-object") {
        return descriptor.fields.some((field) => visit(field.type, active));
      }
      if (descriptor.kind === "fixed-array") {
        return visit(descriptor.element, active);
      }
      return false;
    })();
    active.delete(current);
    cache.set(current, result);
    return result;
  };

  return visit(type, new Set());
};
