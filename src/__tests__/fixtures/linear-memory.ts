export const linearMemoryVoyd = `
use std::linear_memory::all

pub fn run() -> i32
  grow(1)
  store(0, 42)
  load_i32(0)
`;
