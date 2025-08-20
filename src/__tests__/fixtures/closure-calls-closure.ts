export const closureCallsClosureVoyd = `
use std::all

fn call_it(v: i32, cb: (v: i32) -> i32)
  let hi: () -> i32 = () => cb(v)
  hi()

pub fn main() -> i32
  let sum = { val: 0 }
  let set: (v: i32) -> i32 = (v: i32) =>
    sum.val = v
    0
  call_it(4, set)
  sum.val
`;
