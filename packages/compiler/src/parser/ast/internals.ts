/** Defines all internal fn calls */
export type Internal =
  | "ast"
  | "emit_many"
  | "tuple"
  | "paren"
  | "array_literal"
  | "new_array_unchecked"
  | "fixed_array_literal"
  | "object_literal"
  | "label"
  | "new_string"
  | "generics"
  | "map"
  | "scientific_e_notation"
  | "subscript"
  | "subscript_set";
