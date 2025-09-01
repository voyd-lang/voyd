export const msgPackArrayMapVoyd = `
use std::all
use std::vsx::create_element
use std::msg_pack
use std::msg_pack::MsgPack

pub fn component()
  let a = ["Alex", "Abby"]
  <div>
    {a.map<MsgPack>(item => <p>hi {item}</p>)}
  </div>

pub fn run() -> i32
  msg_pack::encode(component())
`;
