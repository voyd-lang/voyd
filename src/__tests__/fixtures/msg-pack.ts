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

pub fn decode_i32(ptr: i32, len: i32) -> i32
  msg_pack::decode_i32(ptr, len)

pub fn decode_string(ptr: i32, len: i32) -> i32
  let value = msg_pack::decode_string(ptr, len)
  msg_pack::encode(value, 0)

pub fn decode_array(ptr: i32, len: i32) -> i32
  let array = msg_pack::decode_array(ptr, len)
  msg_pack::encode(array)

pub fn decode_map(ptr: i32, len: i32) -> i32
  let map = msg_pack::decode_map(ptr, len)
  msg_pack::encode(map)
`;
