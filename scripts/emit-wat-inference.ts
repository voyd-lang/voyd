import { compile } from "../src/compiler.js";

const inferenceVoyd = `
use std::all
use std::msg_pack::MsgPack
use std::vsx::create_element
use std::msg_pack

pub fn component9() -> Map<MsgPack>
  let a = ["Alex", "Abby"]
  <div>
    {a.map(item => <p>hi {item}</p>)}
  </div>

pub fn test9() -> i32
  msg_pack::encode(component9())
`;

async function main() {
  const mod = await compile(inferenceVoyd);
  const text = (mod as any).emitText();
  console.log(text);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

