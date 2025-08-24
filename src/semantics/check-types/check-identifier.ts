import { Identifier } from "../../syntax-objects/identifier.js";

export const checkIdentifier = (id: Identifier) => {
  if (id.is("return") || id.is("break")) return id;

  const entity = id.resolve();
  if (!entity) {
    throw new Error(`Unrecognized identifier, ${id} at ${id.location}`);
  }

  if (entity.isVariable()) {
    if ((id.location?.startIndex ?? 0) <= (entity.location?.startIndex ?? 0)) {
      throw new Error(`${id} used before defined`);
    }
  }

  return id;
};

