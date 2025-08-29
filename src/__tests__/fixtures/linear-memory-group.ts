export const linearMemoryGroupVoyd = `
use std::linear_memory

// 1) load/store roundtrip using module access
pub fn test1() -> i32
  linear_memory::grow(1)
  linear_memory::store(0, 42)
  linear_memory::load_i32(0)

// 2) another load/store (alias style merged into module access)
pub fn test2() -> i32
  linear_memory::grow(1)
  linear_memory::store(0, 42)
  linear_memory::load_i32(0)

// 3) size in bytes
pub fn test3() -> i32
  linear_memory::size() * 65536
`;

