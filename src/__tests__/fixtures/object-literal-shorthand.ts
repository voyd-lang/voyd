export const objectShorthandVoyd = `
use std::all

fn sum_vec({ a: i32, b: i32, c: i32 }) -> i32
  a + b + c

pub fn run() -> i32
  let a = 1
  let b = 2
  let vec = { a, b, c: 3 }
  sum_vec(vec)
`;

