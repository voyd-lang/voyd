export const mapInitVoyd = `
use std::all

pub fn map_from_pairs() -> i32
  let pairs = new_array<(String, i32)>({ with_size: 2 })
  pairs.push(("a", 1))
  pairs.push(("b", 2))
  let m = Map<i32>(pairs)
  m.get("a").match(v)
    Some<i32>:
      v.value
    None:
      -1
`;
