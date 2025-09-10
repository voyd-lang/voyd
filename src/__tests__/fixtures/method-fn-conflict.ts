export const methodFnConflictVoyd = `
use std::all

fn reduce<T>(arr: Array<T>, { start: T, reducer cb: (acc: T, current: T) -> T }) -> T
  let iterator = arr.iterate()
  let reducer: (acc: T) -> T = (acc: T) -> T =>
    iterator.next().match(opt)
      Some<T>:
        reducer(cb(acc, opt.value))
      None:
        acc
  reducer(start)

fn add<T>(a: T, b: T)
  a + b

pub fn test1() -> i32
  [1, 2, 3]
    .reduce<i32> start: 0 reducer: (acc, current) =>
      acc + current
    .add(3)
`;
