export const closureVoyd = `
use std::all

pub fn run() -> i32
  let x = 41
  let add = (y: i32) -> i32 => x + y
  add(1)
`;
