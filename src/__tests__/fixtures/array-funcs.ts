export const arrayFuncsVoyd = `
use std::all

// 1) map + reduce (methods): ([1,2,3,4] |> +1) |> sum = 14
pub fn test1() -> i32
  let arr = [1, 2, 3, 4]
  let mapped = arr.map<i32>((v: i32) -> i32 => v + 1)
  mapped.reduce<i32>(0, (acc: i32, v: i32) -> i32 => acc + v)

fn for_each<I>(it: Iterable<I>, f: (v: I) -> void) -> void
  let iterator = it.iterate()
  while true do:
    iterator.next().match(item)
      Some<I>:
        f(item.value)
        void
      None:
        break

// 2) filter + for_each reduce: evens of [1..5] sum = 6
pub fn test2() -> i32
  let arr = [1, 2, 3, 4, 5]
  let evens = arr.filter((v: i32) -> bool => (v % 2) == 0)
  let sum = { val: 0 }
  for_each<i32>(evens, (v: i32) -> void => sum.val = sum.val + v)
  sum.val

// 3) each (method): side-effect accumulation
pub fn test3() -> i32
  let arr = [1, 2, 3]
  let sum = { val: 0 }
  arr.each((v: i32) -> void => sum.val = sum.val + v)
  sum.val

// 4) Works with non-Array Iterable (Map iterator) via for_each
pub fn test4() -> i32
  let m = new_map<i32>()
  m.set("a", 1)
  m.set("b", 2)
  let vals = new_array<i32>({ with_size: 4 })
  for_each<{ key: String, value: i32 }>(m, (p: { key: String, value: i32 }) -> void =>
    if p.value > 1 then:
      vals.push(p.value)
      void
    else:
      void)
  let total = { val: 0 }
  for_each<i32>(vals, (v: i32) -> void => total.val = total.val + v)
  total.val

// 5) find: first > 2 => 3
pub fn test5() -> i32
  let arr = [1, 2, 3, 4]
  arr.find((v: i32) -> bool => v > 2).match(x)
    Some<i32>:
      x.value
    None:
      -1

// 6) some: any > 3 => 1
pub fn test6() -> i32
  let arr = [1, 2, 3, 4]
  if arr.some((v: i32) -> bool => v > 3) then:
    1
  else:
    0

// 7) every: all > 2 => 0
pub fn test7() -> i32
  let arr = [1, 2, 3, 4]
  if arr.every((v: i32) -> bool => v > 2) then:
    1
  else:
    0
`;
