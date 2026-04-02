// Central inventory for syntax-backed helper contracts.
//
// Keep this list small and update it whenever parser/binder/lowering starts
// synthesizing a new std dependency so boundary audits can reason about the
// compiler-owned surface from one place.
//
// String literals are fully decoupled from curated convenience exports by
// routing through a hidden compiler import of `std::string::new_string`.
// Array literals still intentionally lower to the public
// `std::array::new_array_unchecked` constructor via a hidden compiler import
// until the dedicated array-literal follow-up lands.
export const GENERATED_STRING_LITERAL_HELPER = "__generated_string_literal_new_string";
export const STRING_LITERAL_CONSTRUCTOR_EXPORT = "new_string";
export const STRING_LITERAL_CONSTRUCTOR_MODULE_ID = "std::string";

export const GENERATED_ARRAY_LITERAL_HELPER =
  "__generated_array_literal_new_array_unchecked";
export const ARRAY_LITERAL_CONSTRUCTOR_EXPORT = "new_array_unchecked";
export const ARRAY_LITERAL_CONSTRUCTOR_MODULE_ID = "std::array";
