export const closureVoyd = `
use std::all

pub fn run() -> i32
  let x = 41
  let add_closure = (y: i32) => x + y
  add_closure(1)
`;
