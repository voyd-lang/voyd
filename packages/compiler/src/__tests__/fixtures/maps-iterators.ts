export const mapsIteratorsVoyd = `
use std::all

// 1) Map iterator sums values
pub fn test1() -> i32
  let m = new_map<i32>()
  m.set("a", 1)
  m.set("b", 2)
  let iterator = m.iterate()
  let looper: (s: i32) -> i32 = (acc: i32) =>
    iterator.next().match(item)
      Some<{ key: String, value: i32 }>:
        looper(acc + item.value.value)
      None:
        acc
  looper(0)

// 2) String iterator sums char codes
pub fn test2() -> i32
  let iterator = new_string_iterator("ab")
  let looper: (s: i32) -> i32 = (acc: i32) =>
    iterator.next().match(ch)
      Some<i32>:
        looper(acc + ch.value)
      None:
        acc
  looper(0)

// 3) Map init from pairs
pub fn test3() -> i32
  let m = Map<i32>([
    ("a", 1),
    ("b", 2)
  ])
  m.get("a").match(v)
    Some<i32>:
      v.value
    None:
      -1
`;

