export const genericsInferVoyd = `
use std::all

// 1) Generic fn infers type
fn add<T>(a: T, b: T) -> T
  a + b

pub fn test1() -> i32
  add(1, 2)

// 2) Structural inference from Array<T>
fn head<T>(arr: Array<T>) -> i32
  42

pub fn test2() -> i32
  let arr: Array<i32> = [42]
  head(arr)

// 3) Structural inference from Array<(String, T)>
fn wrap<T>(pairs: Array<(String, T)>) -> i32
  42

pub fn test3() -> i32
  let arr: Array<(String, i32)> = [("a", 42)]
  wrap(arr)

// 4) Generic array reduce
fn reduce_test<T>({ arr: Array<T>, start: T, reducer cb: (acc: T, current: T) -> T }) -> T
  let iterator = arr.iterate()
  let reducer: (acc: T) -> T = (acc: T) =>
    iterator.next().match(opt)
      Some<T>:
        reducer(cb(acc, opt.value))
      None:
        acc
  reducer(start)

pub fn test4() -> i32
  let arr: Array<i32> = [1, 2, 3]
  reduce_test<i32> arr: arr start: 0 reducer: (acc: i32, current: i32) => acc + current
`;
