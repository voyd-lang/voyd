export const msgPackVoyd = `
use std::msg_pack
use std::linear_memory

pub fn run() -> i32
  msg_pack::encode_json(42, 0)
  linear_memory::load_i32(0)
`;
