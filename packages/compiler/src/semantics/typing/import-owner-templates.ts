import type { TypeId } from "../ids.js";
import { symbolRefKey, type SymbolRef } from "./symbol-ref.js";
import type { TypingContext } from "./types.js";
import {
  mapDependencySymbolToLocal,
  registerImportedObjectTemplate,
} from "./import-symbol-mapping.js";

export const ensureImportedOwnerTemplatesAvailable = ({
  types,
  ctx,
}: {
  types: readonly TypeId[];
  ctx: TypingContext;
}): void => {
  const owners: SymbolRef[] = [];
  const seenTypes = new Set<TypeId>();
  const seenOwners = new Set<string>();

  types.forEach((type) =>
    collectOwnerRefs(type, ctx.arena, owners, seenTypes, seenOwners),
  );

  owners.forEach((owner) => {
    if (owner.moduleId === ctx.moduleId) {
      return;
    }
    const dependency = ctx.dependencies.get(owner.moduleId);
    if (!dependency) {
      return;
    }
    const localSymbol = mapDependencySymbolToLocal({
      owner: owner.symbol,
      dependency,
      ctx,
      allowUnexported: true,
    });
    registerImportedObjectTemplate({
      dependency,
      dependencySymbol: owner.symbol,
      localSymbol,
      ctx,
    });
  });
};

const collectOwnerRefs = (
  root: TypeId,
  arena: TypingContext["arena"],
  owners: SymbolRef[],
  seenTypes: Set<TypeId>,
  seenOwners: Set<string>,
): void => {
  const stack: TypeId[] = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (typeof current !== "number") {
      continue;
    }
    if (seenTypes.has(current)) {
      continue;
    }
    seenTypes.add(current);
    const desc = arena.get(current);
    switch (desc.kind) {
      case "nominal-object":
      case "trait": {
        const ownerKey = symbolRefKey(desc.owner);
        if (!seenOwners.has(ownerKey)) {
          seenOwners.add(ownerKey);
          owners.push(desc.owner);
        }
        desc.typeArgs.forEach((arg) => stack.push(arg));
        break;
      }
      case "structural-object":
        desc.fields.forEach((field) => stack.push(field.type));
        break;
      case "function":
        desc.parameters.forEach((param) => stack.push(param.type));
        stack.push(desc.returnType);
        break;
      case "union":
        desc.members.forEach((member) => stack.push(member));
        break;
      case "intersection":
        if (typeof desc.nominal === "number") stack.push(desc.nominal);
        if (typeof desc.structural === "number") stack.push(desc.structural);
        break;
      case "fixed-array":
        stack.push(desc.element);
        break;
      default:
        break;
    }
  }
};
