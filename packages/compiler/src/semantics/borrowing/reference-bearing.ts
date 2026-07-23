import type { TypeId } from "../ids.js";
import type { TypingResult } from "../typing/index.js";

export const typeCanCarryReference = (
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
  return result;
};
