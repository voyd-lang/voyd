export const iterableMapVoyd = `
use std::all

pub fn run() -> i32
  let arr = [1, 2, 3]
  let arr_mapped = map<i32, i32>(arr, (n: i32) => n + 1)
  let arr_val = arr_mapped.get(2).match(v)
    Some<i32>:
      v.value
    None:
      0

  let str = "ab"
  let str_mapped = map<i32, i32>(str, (c: i32) => c + 1)
  let str_val = str_mapped.get(1).match(v2)
    Some<i32>:
      v2.value
    None:
      0

  let m = new_map<i32>()
  m.set("x", 4)
  let map_mapped = map<{ key: string, value: i32 }, i32>(m, (kv: { key: string, value: i32 }) => kv.value + 1)
  let map_val = map_mapped.get(0).match(v3)
    Some<i32>:
      v3.value
    None:
      0

  arr_val + str_val + map_val
`;
