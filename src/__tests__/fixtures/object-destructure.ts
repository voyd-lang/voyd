export const objectDestructureVoyd = `
use std::all

pub fn run() -> i32
  let { x, y: hello, z } = { x: 2, y: 3, z: 4 }
  x + hello + z
`;
