export const e2eVoidText = `
use std::all

fn fib(n: i32) -> i32
  if n < 2 then:
    n
  else:
    fib(n - 1) + fib(n - 2)

pub fn main()
  fib(10)

`;

export const gcVoidText = `
use std::all

obj Vec {
  x: i32,
  y: i32
}

obj Point extends Vec {
  x: i32,
  y: i32,
  z: i32
}

obj Pointy extends Vec {
  x: i32,
  y: i32,
  z: i32
}

obj Bitly extends Vec {
  x: i32,
  y: i32,
  z: i32
}

fn get_x(vec: Vec)
  vec.x

fn get_member(vec: Vec)
  vec.y

fn get_member(vec: Point)
  vec.z

fn get_member(vec: Pointy)
  vec.x

fn get_num_from_vec_sub_obj(vec: Vec)
  match(vec)
    Pointy: get_member(vec)
    Point: get_member(vec)
    else: -1

// Should return 13
pub fn test1()
  let vec = Point { x: 1, y: 2, z: 13 }
  vec.get_member()

// Should return 1
pub fn test2()
  let vec = Pointy { x: 1, y: 2, z: 13 }
  vec.get_member()

// Should return 2
pub fn test3()
  let vec = Vec { x: 1, y: 2 }
  vec.get_member()

// Should return 52
pub fn test4()
  let vec = Point { x: 52, y: 2, z: 21 }
  vec.get_x()

// Test match type guard (Point case), should return 21
pub fn test5()
  let vec = Point { x: 52, y: 2, z: 21 }
  get_num_from_vec_sub_obj(vec)

// Test match type guard (else case), should return -1
pub fn test6()
  let vec = Bitly { x: 52, y: 2, z: 21 }
  get_num_from_vec_sub_obj(vec)
`;

export const tcoText = `
use std::all

// Tail call fib
pub fn fib(n: i32, a: i32, b: i32) -> i32
  if n == 0 then:
    a
  else:
    fib(n - 1, b, a + b)
`;

export const goodTypeInferenceText = `
use std::all

// Should infer return type from fib_alias
fn fib(n: i32, a: i64, b: i64)
  if n == 0 then:
    a
  else:
    fib_alias(n - 1, b, a + b)

fn fib_alias(n: i32, a: i64, b: i64) -> i64
  fib(n - 1, b, a + b)

pub fn main() -> i64
  fib(10, 0i64, 1i64)
`;
