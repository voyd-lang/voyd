export const closureParamVoyd = `
use std::all

fn call_with_five(cb: (x: i32) -> i32) -> i32
  cb(5)

pub fn main() -> i32
  let add = (x: i32) => x + 5
  call_with_five(add)
`;
