import { FixedArrayType } from "../../syntax-objects/types.js";

export const checkFixedArrayType = (array: FixedArrayType) => {
  if (!array.elemType) {
    // Debug: surface more context to trace missing element type
    // eslint-disable-next-line no-console
    console.error(
      `checkFixedArrayType: missing elemType at ${array.location}, elemTypeExpr=${array.elemTypeExpr?.toString?.()}`
    );
    throw new Error(`Unable to determine element type for ${array.location}`);
  }

  return array;
};
