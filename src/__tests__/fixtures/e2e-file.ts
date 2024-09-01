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

fn get_x(vec: Vec)
  vec.x

fn get_member(vec: Vec)
  vec.y

fn get_member(vec: Point)
  vec.z

fn get_member(vec: Pointy)
  vec.x

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

`;
