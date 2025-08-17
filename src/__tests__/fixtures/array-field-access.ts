export const arrayFieldAccessVoyd = `
use std::all

obj ArrayIterator<T> {
  index: i32,
  array: Array<T>
}

pub fn run() -> i32
  let a = [1, 2, 3]
  let b = ArrayIterator<i32> { index: 0, array: a }
  b.array.get(b.index).match(v)
    Some<i32>: v.value
    None:
      -1
`;
