export const mapInitInferVoyd = `
use std::all

pub fn main() -> i32
  let map = Map([
    ("a", 1),
    ("b", 2)
  ])
  map.get("a").match(v)
    Some<i32>:
      v.value
    None:
      -1
`;
