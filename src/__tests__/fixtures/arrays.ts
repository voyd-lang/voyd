export const arraysVoyd = `
use std::all

// 1) Anonymous object literal inside array
pub fn test1() -> i32
  let _b = [{ x: 1, y: 2 }]
  1

// 2) Accessing fields on array elements via wrapper object
obj ArrayIterator<T> {
  index: i32,
  array: Array<T>
}

pub fn test2() -> i32
  let a = [1, 2, 3]
  let b = ArrayIterator<i32> { index: 0, array: a }
  b.array.get(b.index).match(v)
    Some<i32>:
      v.value
    None:
      -1

// 3) Array of nominal objects accepted by structural param
obj JsonNumber { val: i32 }

fn work_obj_arr(val: Array<JsonNumber>) -> i32
  1

pub fn test3() -> i32
  let x = JsonNumber { val: 23 }
  let b: Array<JsonNumber> = [x]
  work_obj_arr(b)

// 4) Array of tuple param (non-generic)
fn f_pairs(pairs: Array<(String, i32)>) -> i32
  42

pub fn test4() -> i32
  let arr: Array<(String, i32)> = [("a", 42)]
  f_pairs(arr)

// 5) Fixed array/object literal construction
obj A { x: i32 }

pub fn test5() -> i32
  let _a = [A { x: 1 }]
  let _b = [{ x: 1, y: 2 }]
  1
`;

