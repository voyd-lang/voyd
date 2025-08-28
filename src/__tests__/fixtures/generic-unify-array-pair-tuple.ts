export const genericUnifyArrayPairTupleVoyd = `
use std::all

// Confirm structural inference of T from a nested pair without
// exercising match/optionals to avoid unrelated recursion.
fn wrap<T>(pairs: Array<(String, T)>) -> i32
  42

pub fn run() -> i32
  let arr: Array<(String, i32)> = [("a", 42)]
  wrap(arr)
`;
