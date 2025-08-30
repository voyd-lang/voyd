export const msgPackVoyd = `
use std::all
use std::msg_pack
use std::msg_pack::MsgPack
use std::linear_memory

pub fn run_i32() -> i32
  msg_pack::encode(42, 0)

pub fn run_string() -> i32
  msg_pack::encode("abc", 0)

pub fn run_array() -> i32
  msg_pack::encode(["hey", "there"])

pub fn run_map() -> i32
  let &m = new_map<MsgPack>()
  m.set("hey", "there")
  m.set("goodbye", "night")
  msg_pack::encode(m)
`;
