import type { TypeId } from "../ids.js";
import type { TypingResult } from "../typing/index.js";

const referenceBearingByTyping = new WeakMap<
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
  return result;
};

export const typeIsDefinitelyAllocationBacked = (
  typeId: TypeId,
  typing: TypingResult,
  active = new Set<TypeId>(),
): boolean => {
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
  return result;
};
