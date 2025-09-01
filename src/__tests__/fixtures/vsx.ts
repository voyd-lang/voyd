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

