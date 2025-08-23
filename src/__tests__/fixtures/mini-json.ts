export const miniJsonVoyd = `
obj JsonObj { val: i32 }

type MiniJson = JsonObj | string

fn takes(j: MiniJson) -> i32
  3

pub fn main() -> i32
  takes("hello")
`;
