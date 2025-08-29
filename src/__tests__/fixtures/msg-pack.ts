export const msgPackVoyd = `
use std::all

pub fn run_i32() -> i32
  msg_pack::encode_json(42, 0)

pub fn run_string() -> i32
  msg_pack::encode_json("abc", 0)

pub fn run_array() -> i32
  msg_pack::encode_json(["hey", "there"])

pub fn run_map() -> i32
  msg_pack::encode_json(Map([
    ("hey", "there"),
    ("arr", ["d"])
  ]))
`;
