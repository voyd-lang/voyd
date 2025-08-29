export const genericsUnionInferVoyd = `
use std::all

// Generic function with a union-typed parameter
fn use_union<T>(val: Array<T> | String) -> i32
  7

// Alias-based union type
type Html<T> = Array<T> | String

fn use_alias<T>(val: Html<T>) -> i32
  9

// Ensure pairwise union-variant unification infers T from the union argument
pub fn test1() -> i32
  // Argument variants are out-of-order relative to parameter union
  use_union(if true then: "x" else: [1, 2, 3])

// Also infer through a union type alias
pub fn test2() -> i32
  use_alias(if true then: "x" else: [1, 2, 3])
`;
