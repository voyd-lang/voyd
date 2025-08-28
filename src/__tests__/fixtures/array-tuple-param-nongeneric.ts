export const arrayTupleParamVoyd = `
use std::all

fn f(pairs: Array<(String, i32)>) -> i32
  42

pub fn run() -> i32
  let arr: Array<(String, i32)> = [("a", 42)]
  f(arr)
`;

