export const msgPackArrayMapVoyd = `
use std::all
use std::vsx::create_element
use std::msg_pack::MsgPack

pub fn component()
  let a = ["hello", "there"]
  <div>
    {a.map<MsgPack>(item => <p>item</p>)}
  </div>

pub fn main() -> i32
  // Ensure map<MsgPack> inside HTML compiles without ambiguous push
  component()
  1
`;
