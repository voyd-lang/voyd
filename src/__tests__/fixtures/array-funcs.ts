export const arrayFuncsVoyd = `
use std::all

// 1) map + reduce: ([1,2,3,4] |> +1) |> sum = 14
pub fn test1() -> i32
  let arr = [1, 2, 3, 4]
  let mapped = map<i32, i32>(arr, (v: i32) -> i32 => v + 1)
  reduce<i32, i32>(mapped, 0, (acc: i32, v: i32) -> i32 => acc + v)

// 2) filter + reduce: evens of [1..5] sum = 6
pub fn test2() -> i32
  let arr = [1, 2, 3, 4, 5]
  let evens = filter<i32>(arr, (v: i32) -> bool => (v % 2) == 0)
  reduce<i32, i32>(evens, 0, (acc: i32, v: i32) -> i32 => acc + v)

// 3) each: side-effect accumulation
pub fn test3() -> i32
  let arr = [1, 2, 3]
  let sum = { val: 0 }
  each<i32>(arr, (v: i32) -> void => sum.val = sum.val + v)
  sum.val

// 4) Works with non-Array Iterable (Map iterator)
pub fn test4() -> i32
  let m = new_map<i32>()
  m.set("a", 1)
  m.set("b", 2)
  let vals = map<{ key: String, value: i32 }, i32>(m, (p: { key: String, value: i32 }) -> i32 => p.value)
  let filtered = filter<i32>(vals, (v: i32) -> bool => v > 1)
  reduce<i32, i32>(filtered, 0, (acc: i32, v: i32) -> i32 => acc + v)
`;
