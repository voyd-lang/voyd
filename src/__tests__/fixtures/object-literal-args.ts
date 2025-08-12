export const objectLiteralArgsVoyd = `
use std::all

fn move({ x: i32, y: i32, z: i32 }) -> i32
  x + y + z

pub fn call_move() -> i32
  let vec = { x: 1, y: 2, z: 3 }
  move(vec)
`;
