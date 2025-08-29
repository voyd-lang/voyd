export const genericsUnionInferVoyd = `
use std::all

// Generic function with a union-typed parameter
fn use_union<T>(val: Array<T> | String) -> i32
  7

// Ensure pairwise union-variant unification infers T from the union argument
pub fn test1() -> i32
  use_union(if true then: [1, 2, 3] else: "x")
`;
