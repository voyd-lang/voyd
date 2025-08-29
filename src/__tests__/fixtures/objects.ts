export const objectsVoyd = `
use std::all

// 1) Object destructuring
pub fn test1() -> i32
  let { x, y: hello, z } = { x: 2, y: 3, z: 4 }
  x + hello + z

// 2) Object literal shorthand and labeled param expansion
fn sum_vec({ a: i32, b: i32, c: i32 }) -> i32
  a + b + c

pub fn test2() -> i32
  let a = 1
  let b = 2
  let vec = { a, b, c: 3 }
  sum_vec(vec)

// 3 & 4) Object init arg expansion from var and param
obj Pt {
  x: i32,
  y: i32
}

pub fn test3() -> i32
  let opts = { x: 2, y: 3 }
  let p = Pt(opts)
  p.x

fn wrap(o: { x: i32, y: i32 }) -> Pt
  Pt(o)

pub fn test4() -> i32
  let o = { x: 4, y: 5 }
  wrap(o).x

// 5) Tuple destructuring
pub fn test5() -> i32
  let (a, b, c) = (1, 2, 3)
  a + b + c
`;

