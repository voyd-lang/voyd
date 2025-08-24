export const miniJsonArrayVoyd = `
use std::all

pub obj JsonNull {}
pub obj JsonNumber { val: i32 }

type MiniJson = Array<MiniJson> | JsonNumber

fn work(val: Array<MiniJson>) -> i32
  1

pub fn run() -> i32
  let a: Array<MiniJson> = [JsonNumber { val: 23 }]
  work(a)
  work([JsonNumber { val: 23 }])
`;
