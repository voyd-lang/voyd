export const msgPackVoyd = `
use std::msg_pack
use std::linear_memory
use std::map
type MiniJson = Map<MiniJson> | Array<MiniJson> | String

pub fn run_i32() -> i32
  msg_pack::encode_json(42, 0)

pub fn run_string() -> i32
  msg_pack::encode_json("abc", 0)

pub fn run_array() -> i32
  msg_pack::encode_json(["hey", "there"])

pub fn run_map() -> i32
  let m = new_map<MiniJson>()
  m.set("hello", "world")
  msg_pack::encode_json(m)
`;
