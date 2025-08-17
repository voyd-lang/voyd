export const closureRecursionVoyd = `
use std::all

pub fn run() -> i32
  let sum: (n: i32) -> i32 = (n: i32) =>
    if n <= 1 then:
      n
    else:
      n + sum(n - 1)
  sum(5)
`;
