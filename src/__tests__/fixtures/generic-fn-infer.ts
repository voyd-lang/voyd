export const genericFnInferVoyd = `
use std::all

fn add<T>(a: T, b: T) -> T
  a + b

pub fn run() -> i32
  add(1, 2)
`;
