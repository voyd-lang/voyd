export const msgPackVoyd = `
use std::msg_pack
use std::linear_memory

pub fn run_i32() -> i32
  msg_pack::encode_json(42, 0)

pub fn run_string() -> i32
  msg_pack::encode_json("abc", 0)
`;
