export const mapStringIteratorVoyd = `
use std::all

pub fn map_iter_sum() -> i32
  let m = new_map<i32>()
  m.set("a", 1)
  m.set("b", 2)
  let iterator = &m.iterate()
  let looper: (s: i32) -> i32 = (acc: i32) =>
    iterator.next().match(item)
      Some<{ key: String, value: i32 }>:
        looper(acc + item.value.value)
      None:
        acc
  looper(0)

pub fn string_iter_sum() -> i32
  let iterator = &new_string_iterator("ab")
  let looper: (s: i32) -> i32 = (acc: i32) =>
    iterator.next().match(ch)
      Some<i32>:
        looper(acc + ch.value)
      None:
        acc
  looper(0)
`;
