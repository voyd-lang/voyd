import { FixedArrayType } from "../../syntax-objects/types.js";

export const checkFixedArrayType = (array: FixedArrayType) => {
  if (!array.elemType) {
    throw new Error(`Unable to determine element type for ${array.location}`);
  }

  return array;
};
