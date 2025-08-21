export const jsonMsgpackVoyd = `
use std::linear_memory::{ grow, store8 }

pub fn run(ptr: i32) -> i32
  grow(1)
  store8(ptr + 0, 131)
  store8(ptr + 1, 161)
  store8(ptr + 2, 97)
  store8(ptr + 3, 1)
  store8(ptr + 4, 161)
  store8(ptr + 5, 98)
  store8(ptr + 6, 146)
  store8(ptr + 7, 195)
  store8(ptr + 8, 162)
  store8(ptr + 9, 104)
  store8(ptr + 10, 105)
  store8(ptr + 11, 161)
  store8(ptr + 12, 99)
  store8(ptr + 13, 192)
  14
`;
