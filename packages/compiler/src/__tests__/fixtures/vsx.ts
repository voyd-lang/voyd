export const vsxVoyd = `
use std::all
use std::vsx::create_element
use std::msg_pack

pub fn main()
  <div class="size-full rounded bg-black">
    <p class="prose">
      Hello World!
    </p>
    <p class="prose">
      I am M87
    </p>
  </div>

pub fn run() -> i32
  msg_pack::encode(main())
`;

export const vsxComponentsVoyd = `
use std::all
use std::vsx::create_element
use std::msg_pack
use std::msg_pack::MsgPack

pub fn Card({ name: String, children?: Array<MsgPack> })
  let content = if c := children then: c else: []

  <div class="card">
    <h1 class="card-title">Hello {name}</h1>
    {content}
  </div>


pub fn App()
  <div class="size-full rounded bg-black">
    <Card name="Drew">
      This is a card. This content is passed as an array to the children prop.
    </Card>
  </div>

pub fn run() -> i32
  msg_pack::encode(App())
`;
