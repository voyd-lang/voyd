export const linearMemoryVoyd = `
use std::linear_memory::{ grow: grow_linear_mem, store, load_i32 }

pub fn run() -> i32
  grow_linear_mem(1)
  store(0, 42)
  load_i32(0)
`;

export const linearMemoryModuleVoyd = `
use std::linear_memory

pub fn run() -> i32
  linear_memory::grow(1)
  linear_memory::store(0, 42)
  linear_memory::load_i32(0)
`;

export const linearMemorySizeVoyd = `
use std::linear_memory

pub fn run() -> i32
  linear_memory::size() * 65536
`;
