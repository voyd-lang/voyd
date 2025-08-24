export const genericArrayReduceVoyd = `
use std::all

fn reduce<T>({ arr: Array<T>, start: T, reducer cb: (acc: T, current: T) -> T }) -> T
  let iterator = &arr.iterate()
  let reducer: (acc: T) -> T = (acc: T) =>
    iterator.next().match(opt)
      Some<T>:
        reducer(cb(acc, opt.value))
      None:
        acc
  reducer(start)

pub fn run() -> i32
  let arr: Array<i32> = [1, 2, 3]
  reduce<i32> arr: arr start: 0 reducer: (acc: i32, current: i32) => acc + current
`;
