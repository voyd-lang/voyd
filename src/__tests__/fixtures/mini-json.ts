export const miniJsonVoyd = `
pub obj JsonNull {}
pub obj JsonNumber { val: i32 }

pub type Json = Map<Json> | Array<Json> | JsonNumber | JsonNull | string

type MiniJson = Array<MiniJson> | string

pub fn main() -> i32
  0
`;
