import {
  Type,
  isStructType,
  CDT_ADDRESS_TYPE,
  Expr,
  isPrimitiveType,
  StructType,
} from "../../../lib/index.mjs";

export const typesMatch = (expected?: Type, given?: Type) => {
  if (isStructType(expected) && isStructType(given)) {
    return structArgsMatch(expected, given);
  }

  return expected?.is(given) || isStructPointerMatch(expected, given);
};

// Until a more complex type system is implemented, assume that non-primitive types
// Can be treated as i32's.
const isStructPointerMatch = (expected?: Type, given?: Expr) =>
  (!isPrimitiveType(expected) && given?.is(CDT_ADDRESS_TYPE)) ||
  (!isPrimitiveType(given) && expected?.is(CDT_ADDRESS_TYPE));

const structArgsMatch = (expected: StructType, given: StructType): boolean => {
  return (
    expected.value.length === given.value.length &&
    expected.value.every((field) =>
      given.value.some((arg) => typesMatch(field.type, arg.type))
    )
  );
};
