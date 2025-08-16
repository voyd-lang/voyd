export const linearMemoryVoyd = `
use std::memory::all

pub fn run() -> i32
  grow(1)
  store_i32(0, 42)
  load_i32(0)
`;
