export const omitTypeParamsInPatternMatch = `
use std::all
use std::msg_pack::MsgPack

pub fn main() -> i32
  let m = Map<MsgPack>([
    ("hey", "hi"),
    ("goodbye", "hey")
  ])
  m.get("hey").match(v)
    Some:
      1
    None:
      -1
`;
