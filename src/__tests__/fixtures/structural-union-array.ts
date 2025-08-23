export const structuralUnionArrayVoyd = `
use std::all

pub obj JsonNull {}
pub obj JsonNumber { val: i32 }

pub type Json = Map<Json> | Array<Json> | JsonNumber | JsonNull | string

type MiniJson = Array<MiniJson> | string

fn work(val: Array<MiniJson>) -> i32
  1

pub fn main() -> i32
  work(new_array<MiniJson>({ from: FixedArray<MiniJson>("hey") }))
`;

