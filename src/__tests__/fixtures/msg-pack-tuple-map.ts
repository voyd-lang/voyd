export const msgPackTupleMapVoyd = `
use std::all
use std::msg_pack::MsgPack

pub fn main() -> i32
  let x: Array<(String, MsgPack)> = [
    ("hey", "hi"),
    ("goodbye", "hey")
  ]
  let m = Map<MsgPack>(x)
  m.get("hey").match(v)
    Some<MsgPack>:
      1
    None:
      -1
`;

