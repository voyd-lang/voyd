export const throwsWithMissingField = `
use std::all

obj Point extends Vec {
  x: i32,
  y: i32,
  z: i32
}

pub fn main() -> i32
  let vec = Point { x: 1, y: 2 }
  vec.x
`;

export const throwsWithBadReturn = `
use std::all

pub fn main() -> i32
  let fl = 1.23
  fl
`;
