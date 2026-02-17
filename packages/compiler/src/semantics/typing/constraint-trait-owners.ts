import type { TypeId } from "../ids.js";
import type { SymbolRef } from "./symbol-ref.js";
import type { TypingContext } from "./types.js";

type ConstrainedTypeParam = {
  constraint?: TypeId;
};

const collectTraitOwnersInType = ({
  type,
  arena,
  owners,
  seen,
}: {
  type: TypeId;
  arena: TypingContext["arena"];
  owners: Map<string, SymbolRef>;
  seen: Set<TypeId>;
}): void => {
  if (seen.has(type)) {
    return;
  }
  seen.add(type);

  const desc = arena.get(type);
  switch (desc.kind) {
    case "trait":
      owners.set(`${desc.owner.moduleId}::${desc.owner.symbol}`, desc.owner);
      desc.typeArgs.forEach((arg) =>
        collectTraitOwnersInType({ type: arg, arena, owners, seen }),
      );
      return;
    case "nominal-object":
      desc.typeArgs.forEach((arg) =>
        collectTraitOwnersInType({ type: arg, arena, owners, seen }),
      );
      return;
    case "structural-object":
      desc.fields.forEach((field) =>
        collectTraitOwnersInType({ type: field.type, arena, owners, seen }),
      );
      return;
    case "function":
      desc.parameters.forEach((param) =>
        collectTraitOwnersInType({ type: param.type, arena, owners, seen }),
      );
      collectTraitOwnersInType({
        type: desc.returnType,
        arena,
        owners,
        seen,
      });
      return;
    case "union":
      desc.members.forEach((member) =>
        collectTraitOwnersInType({ type: member, arena, owners, seen }),
      );
      return;
    case "intersection":
      desc.traits?.forEach((trait) =>
        collectTraitOwnersInType({ type: trait, arena, owners, seen }),
      );
      if (typeof desc.nominal === "number") {
        collectTraitOwnersInType({
          type: desc.nominal,
          arena,
          owners,
          seen,
        });
      }
      if (typeof desc.structural === "number") {
        collectTraitOwnersInType({
          type: desc.structural,
          arena,
          owners,
          seen,
        });
      }
      return;
    case "recursive":
      collectTraitOwnersInType({
        type: desc.body,
        arena,
        owners,
        seen,
      });
      return;
    case "fixed-array":
      collectTraitOwnersInType({
        type: desc.element,
        arena,
        owners,
        seen,
      });
      return;
    default:
      return;
  }
};

export const collectTraitOwnersFromTypeParams = ({
  typeParams,
  arena,
}: {
  typeParams: readonly ConstrainedTypeParam[] | undefined;
  arena: TypingContext["arena"];
}): Map<string, SymbolRef> => {
  const owners = new Map<string, SymbolRef>();
  if (!typeParams || typeParams.length === 0) {
    return owners;
  }

  const seen = new Set<TypeId>();
  typeParams.forEach((param) => {
    if (typeof param.constraint !== "number") {
      return;
    }
    collectTraitOwnersInType({
      type: param.constraint,
      arena,
      owners,
      seen,
    });
  });
  return owners;
};
