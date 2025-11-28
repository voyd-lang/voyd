export const genericsUnionInferNegativeVoyd = `
use std::all

fn use_union<T>(val: Array<T> | String) -> i32
  7

pub fn bad() -> i32
  // This produces a union with an extra variant (i32) that is not accepted
  // by the parameter type (Array<T> | String)
  let v = if true then: (if true then: [1, 2, 3] else: 42) else: "x"
  use_union(v)
`;

