import {
  Type,
  CDT_ADDRESS_TYPE,
  Expr,
  ObjectType,
} from "../../../lib/index.mjs";

export const typesMatch = (expected?: Type, given?: Type) => {
  if (expected?.isStructType() && given?.isStructType()) {
    return structArgsMatch(expected, given);
  }

  return expected?.is(given) || isStructPointerMatch(expected, given);
};

// Until a more complex type system is implemented, assume that non-primitive types
// Can be treated as i32's.
const isStructPointerMatch = (expected?: Type, given?: Expr) =>
  (!expected?.isPrimitiveType() && given?.is(CDT_ADDRESS_TYPE)) ||
  (!given?.isPrimitiveType() && expected?.is(CDT_ADDRESS_TYPE));

const structArgsMatch = (expected: ObjectType, given: ObjectType): boolean => {
  return (
    expected.value.length === given.value.length &&
    expected.value.every((field) =>
      given.value.some((arg) => typesMatch(field.type, arg.type))
    )
  );
};
