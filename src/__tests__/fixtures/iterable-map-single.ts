export const iterableMapSingleVoyd = `
use std::all

pub fn run() -> i32
  let arr = [1, 2, 3]
  let arr_mapped = map<i32, i32>(arr, (n: i32) => n + 1)
  let arr_val = arr_mapped.get(2).match(v)
    Some<i32>:
      v.value
    None:
      0

  arr_val
`;

