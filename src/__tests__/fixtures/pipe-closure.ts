export const pipeClosureVoyd = `
use std::all

pub fn main() -> i32
  2
    .(x: i32) => x + 3
    .(x: i32) => x * 5
`;
