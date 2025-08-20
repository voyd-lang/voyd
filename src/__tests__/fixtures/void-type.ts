export const voidTypeVoyd = `
use std::all

fn call_it(it: (v: i32) -> voyd) -> voyd
  it(5)

pub fn main() -> i32
  let sum = { val: 0 }

  let set = (v: i32) -> voyd =>
    sum.val = v

  call_it(set)
  sum.val
`;

