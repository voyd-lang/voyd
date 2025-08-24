import { TypeAlias } from "../../syntax-objects/types.js";

export const checkTypeAlias = (alias: TypeAlias): TypeAlias => {
  if (alias.typeParameters) return alias;

  if (!alias.type) {
    throw new Error(
      `Unable to determine type for ${JSON.stringify(
        alias.typeExpr,
        undefined,
        2
      )} at ${alias.location}`
    );
  }

  return alias;
};

