import type { TypeId } from "../ids.js";
import type { TypingResult } from "../typing/index.js";
import type { BorrowEndpointAccess, PlaceProjection } from "./model.js";
import { projectionPathCovers } from "./model.js";
import { borrowedPathsInType, typeContainsBorrowed } from "./borrowed-types.js";

export type ReferenceTypeOrigin = {
  path: readonly PlaceProjection[];
  endpointAccess: BorrowEndpointAccess;
};

const MAX_REFERENCE_ORIGIN_DEPTH = 8;
const MAX_REFERENCE_ORIGIN_VISITS = 512;
const referenceOriginsByTyping = new WeakMap<
  TypingResult,
  Map<TypeId, readonly ReferenceTypeOrigin[]>
>();

export const referenceOriginsInType = (
  typeId: TypeId,
  typing: TypingResult,
): readonly ReferenceTypeOrigin[] => {
  const cache = referenceOriginsByTyping.get(typing) ?? new Map();
  referenceOriginsByTyping.set(typing, cache);
  const cached = cache.get(typeId);
  if (cached) {
    return cached;
  }
  let visits = 0;
  const visit = ({
    type,
    prefix,
    stored,
    active,
  }: {
    type: TypeId;
    prefix: readonly PlaceProjection[];
    stored: boolean;
    active: ReadonlySet<TypeId>;
  }): readonly ReferenceTypeOrigin[] => {
    visits += 1;
    if (
      active.has(type) ||
      prefix.length >= MAX_REFERENCE_ORIGIN_DEPTH ||
      visits > MAX_REFERENCE_ORIGIN_VISITS
    ) {
      return [
        {
          path: prefix,
          endpointAccess: stored ? "dereferenced" : "inline",
        },
      ];
    }
    const nextActive = new Set(active).add(type);
    const descriptor = typing.arena.get(type);
    if (descriptor.kind === "borrowed") {
      return visit({
        type: descriptor.inner,
        prefix,
        stored,
        active: nextActive,
      });
    }
    if (descriptor.kind === "primitive") {
      return [];
    }
    if (descriptor.kind === "recursive") {
      return visit({
        type: descriptor.body,
        prefix,
        stored,
        active: nextActive,
      });
    }
    if (descriptor.kind === "union") {
      return descriptor.members.flatMap((member) =>
        visit({
          type: member,
          prefix,
          stored,
          active: nextActive,
        }),
      );
    }
    if (descriptor.kind === "intersection") {
      return [descriptor.nominal, descriptor.structural].flatMap((member) =>
        typeof member === "number"
          ? visit({
              type: member,
              prefix,
              stored,
              active: nextActive,
            })
          : [],
      );
    }
    const fields =
      descriptor.kind === "structural-object"
        ? descriptor.fields
        : descriptor.kind === "nominal-object" ||
            descriptor.kind === "value-object"
          ? typing.objectsByNominal.get(type)?.fields
          : undefined;
    const contained =
      fields?.flatMap((field) =>
        visit({
          type: field.type,
          prefix: [
            ...prefix,
            Number.isInteger(Number(field.name))
              ? { kind: "tuple", index: Number(field.name) }
              : { kind: "field", name: field.name },
          ],
          stored: true,
          active: nextActive,
        }),
      ) ?? [];
    const rootCarriesIdentity =
      descriptor.kind === "nominal-object" ||
      descriptor.kind === "trait" ||
      descriptor.kind === "function" ||
      descriptor.kind === "type-param-ref" ||
      descriptor.kind === "fixed-array";
    const root = rootCarriesIdentity
      ? [
          {
            path: prefix,
            endpointAccess: stored
              ? ("dereferenced" as const)
              : ("inline" as const),
          },
        ]
      : [];
    const elements =
      descriptor.kind === "fixed-array"
        ? visit({
            type: descriptor.element,
            prefix: [...prefix, { kind: "index", stable: false }],
            stored: true,
            active: nextActive,
          })
        : [];
    return [...root, ...contained, ...elements];
  };
  const origins = Array.from(
    new Map(
      visit({
        type: typeId,
        prefix: [],
        stored: false,
        active: new Set(),
      }).map((origin) => [JSON.stringify(origin), origin]),
    ).values(),
  );
  cache.set(typeId, origins);
  return origins;
};

export const retainableReferencePathsInType = (
  typeId: TypeId,
  typing: TypingResult,
): readonly (readonly PlaceProjection[])[] => {
  const borrowedPaths = borrowedPathsInType(typeId, typing);
  const samePathHasOrdinaryAlternative = (
    path: readonly PlaceProjection[],
  ): boolean =>
    projectedTypesAtPath(typeId, path, typing).some((projected) =>
      typeAlternatives(projected, typing).some(
        (alternative) =>
          typeCanCarryReference(alternative, typing) &&
          !typeContainsBorrowed(alternative, typing),
      ),
    );
  return Array.from(
    new Map(
      referenceOriginsInType(typeId, typing)
        .map((origin) => origin.path)
        .filter(
          (path) =>
            !borrowedPaths.some(
              (borrowed) =>
                !(
                  JSON.stringify(path) === JSON.stringify(borrowed) &&
                  samePathHasOrdinaryAlternative(path)
                ) &&
                (projectionPathCovers(path, borrowed) ||
                  projectionPathCovers(borrowed, path)),
            ),
        )
        .map((path) => [JSON.stringify(path), path]),
    ).values(),
  );
};

const projectedTypesAtPath = (
  typeId: TypeId,
  path: readonly PlaceProjection[],
  typing: TypingResult,
  active = new Set<TypeId>(),
): readonly TypeId[] => {
  if (path.length === 0 || active.has(typeId)) {
    return path.length === 0 ? [typeId] : [];
  }
  const nextActive = new Set(active).add(typeId);
  const descriptor = typing.arena.get(typeId);
  if (descriptor.kind === "borrowed") {
    return projectedTypesAtPath(descriptor.inner, path, typing, nextActive);
  }
  if (descriptor.kind === "recursive") {
    return projectedTypesAtPath(descriptor.body, path, typing, nextActive);
  }
  if (descriptor.kind === "union") {
    return descriptor.members.flatMap((member) =>
      projectedTypesAtPath(member, path, typing, nextActive),
    );
  }
  if (descriptor.kind === "intersection") {
    return [descriptor.nominal, descriptor.structural].flatMap((member) =>
      typeof member === "number"
        ? projectedTypesAtPath(member, path, typing, nextActive)
        : [],
    );
  }
  const [projection, ...remaining] = path;
  if (projection?.kind === "dereference") {
    return projectedTypesAtPath(typeId, remaining, typing, active);
  }
  if (projection?.kind === "index" && descriptor.kind === "fixed-array") {
    return projectedTypesAtPath(
      descriptor.element,
      remaining,
      typing,
      nextActive,
    );
  }
  const fields =
    descriptor.kind === "structural-object"
      ? descriptor.fields
      : descriptor.kind === "nominal-object" ||
          descriptor.kind === "value-object"
        ? typing.objectsByNominal.get(typeId)?.fields
        : undefined;
  const field =
    projection?.kind === "field"
      ? fields?.find((candidate) => candidate.name === projection.name)
      : projection?.kind === "tuple"
        ? fields?.[projection.index]
        : undefined;
  return field
    ? projectedTypesAtPath(field.type, remaining, typing, nextActive)
    : [];
};

const typeAlternatives = (
  typeId: TypeId,
  typing: TypingResult,
  active = new Set<TypeId>(),
): readonly TypeId[] => {
  if (active.has(typeId)) {
    return [];
  }
  const nextActive = new Set(active).add(typeId);
  const descriptor = typing.arena.get(typeId);
  if (descriptor.kind === "union") {
    return descriptor.members.flatMap((member) =>
      typeAlternatives(member, typing, nextActive),
    );
  }
  if (descriptor.kind === "recursive") {
    return typeAlternatives(descriptor.body, typing, nextActive);
  }
  return [typeId];
};

const referenceBearingByTyping = new WeakMap<
  TypingResult,
  Map<TypeId, boolean>
>();
const allocationBackedByTyping = new WeakMap<
  TypingResult,
  Map<TypeId, boolean>
>();
const definitelyAllocationBackedByTyping = new WeakMap<
  TypingResult,
  Map<TypeId, boolean>
>();

export const typeCanCarryReference = (
  typeId: TypeId,
  typing: TypingResult,
  active = new Set<TypeId>(),
): boolean => {
  const cache =
    active.size === 0
      ? (referenceBearingByTyping.get(typing) ?? new Map<TypeId, boolean>())
      : undefined;
  if (cache && !referenceBearingByTyping.has(typing)) {
    referenceBearingByTyping.set(typing, cache);
  }
  const cached = cache?.get(typeId);
  if (cached !== undefined) {
    return cached;
  }
  if (active.has(typeId)) {
    return false;
  }
  active.add(typeId);

  const descriptor = typing.arena.get(typeId);
  const result = (() => {
    switch (descriptor.kind) {
      case "borrowed":
        return true;
      case "primitive":
        return false;
      case "value-object": {
        const object = typing.objectsByNominal.get(typeId);
        return object
          ? object.fields.some((field) =>
              typeCanCarryReference(field.type, typing, active),
            )
          : true;
      }
      case "nominal-object":
      case "trait":
      case "structural-object":
      case "fixed-array":
      case "function":
      case "type-param-ref":
        return true;
      case "recursive":
        return typeCanCarryReference(descriptor.body, typing, active);
      case "union":
        return descriptor.members.some((member) =>
          typeCanCarryReference(member, typing, active),
        );
      case "intersection":
        return typeof descriptor.nominal === "number"
          ? typeCanCarryReference(descriptor.nominal, typing, active)
          : typeof descriptor.structural === "number"
            ? typeCanCarryReference(descriptor.structural, typing, active)
            : true;
    }
  })();

  active.delete(typeId);
  cache?.set(typeId, result);
  return result;
};

export const typeIsAllocationBacked = (
  typeId: TypeId,
  typing: TypingResult,
  active = new Set<TypeId>(),
): boolean => {
  const cache =
    active.size === 0
      ? (allocationBackedByTyping.get(typing) ?? new Map<TypeId, boolean>())
      : undefined;
  if (cache && !allocationBackedByTyping.has(typing)) {
    allocationBackedByTyping.set(typing, cache);
  }
  const cached = cache?.get(typeId);
  if (cached !== undefined) {
    return cached;
  }
  if (active.has(typeId)) {
    return false;
  }
  active.add(typeId);
  const descriptor = typing.arena.get(typeId);
  const result = (() => {
    switch (descriptor.kind) {
      case "borrowed":
        return typeIsAllocationBacked(descriptor.inner, typing, active);
      case "primitive":
      case "value-object":
      case "structural-object":
        return false;
      case "nominal-object":
      case "trait":
      case "fixed-array":
      case "function":
      case "type-param-ref":
        return true;
      case "recursive":
        return typeIsAllocationBacked(descriptor.body, typing, active);
      case "union":
        return descriptor.members.some((member) =>
          typeIsAllocationBacked(member, typing, new Set(active)),
        );
      case "intersection":
        return typeof descriptor.nominal === "number"
          ? typeIsAllocationBacked(descriptor.nominal, typing, new Set(active))
          : typeof descriptor.structural === "number"
            ? typeIsAllocationBacked(
                descriptor.structural,
                typing,
                new Set(active),
              )
            : (descriptor.traits?.length ?? 0) > 0;
    }
  })();
  active.delete(typeId);
  cache?.set(typeId, result);
  return result;
};

export const typeIsDefinitelyAllocationBacked = (
  typeId: TypeId,
  typing: TypingResult,
  active = new Set<TypeId>(),
): boolean => {
  const cache =
    active.size === 0
      ? (definitelyAllocationBackedByTyping.get(typing) ??
        new Map<TypeId, boolean>())
      : undefined;
  if (cache && !definitelyAllocationBackedByTyping.has(typing)) {
    definitelyAllocationBackedByTyping.set(typing, cache);
  }
  const cached = cache?.get(typeId);
  if (cached !== undefined) {
    return cached;
  }
  if (active.has(typeId)) {
    return false;
  }
  active.add(typeId);
  const descriptor = typing.arena.get(typeId);
  const result = (() => {
    switch (descriptor.kind) {
      case "borrowed":
        return typeIsDefinitelyAllocationBacked(
          descriptor.inner,
          typing,
          active,
        );
      case "primitive":
      case "value-object":
      case "structural-object":
        return false;
      case "nominal-object":
      case "fixed-array":
      case "function":
        return true;
      case "trait":
      case "type-param-ref":
        return false;
      case "recursive": {
        const nominal = typing.arena.nominalComponent(typeId);
        return typeIsDefinitelyAllocationBacked(
          typeof nominal === "number" ? nominal : descriptor.body,
          typing,
          active,
        );
      }
      case "union":
        return (
          descriptor.members.length > 0 &&
          descriptor.members.every((member) =>
            typeIsDefinitelyAllocationBacked(member, typing, new Set(active)),
          )
        );
      case "intersection":
        return typeof descriptor.nominal === "number"
          ? typeIsDefinitelyAllocationBacked(
              descriptor.nominal,
              typing,
              new Set(active),
            )
          : false;
    }
  })();
  active.delete(typeId);
  cache?.set(typeId, result);
  return result;
};
