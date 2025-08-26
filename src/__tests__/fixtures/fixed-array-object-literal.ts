export const fixedArrayObjectLiteralVoyd = `
use std::all

obj A { x: i32 }

pub fn run() -> i32
  let a = [A { x: 1 }]
  let b = [{ x: 1, y: 2 }]
  1
`;

