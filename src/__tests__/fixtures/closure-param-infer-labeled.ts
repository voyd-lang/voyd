export const closureParamInferLabeledVoyd = `
use std::all

fn call_with_reducer({ start: i32, reducer cb: (acc: i32, current: i32) -> i32 }) -> i32
  cb(start, 5)

pub fn main() -> i32
  call_with_reducer start: 1 reducer: (acc, current) => acc + current
`;
