export const closureParamInferOneVoyd = `
use std::all

fn call_with_five(cb: (x: i32) -> i32) -> i32
  cb(5)

pub fn main() -> i32
  call_with_five(x => x + 5)
`;

export const closureParamInferTwoVoyd = `
use std::all

fn call_with_args(cb: (x: i32, y: i32) -> i32, x: i32, y: i32) -> i32
  cb(x, y)

pub fn main() -> i32
  call_with_args((x, y) => x + y, 3, 4)
`;
