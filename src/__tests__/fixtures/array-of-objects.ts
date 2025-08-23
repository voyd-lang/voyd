export const arrayOfObjectsVoyd = `
use std::all

pub obj JsonNumber { val: i32 }

fn work(val: Array<JsonNumber>) -> i32
  1

pub fn run() -> i32
  let x = JsonNumber { val: 23 }
  let b: Array<JsonNumber> = [x]
  work(b)
`;
