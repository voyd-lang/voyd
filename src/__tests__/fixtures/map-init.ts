export const mapInitVoyd = `
use std::all

pub fn map_from_pairs() -> i32
  let m = Map<i32>([
    ("a", 1),
    ("b", 2)
  ])
  m.get("a").match(v)
    Some<i32>:
      v.value
    None:
      -1
`;
