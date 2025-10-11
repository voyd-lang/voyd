export const mapRecursiveUnionVoyd = `
use std::all

pub type RecType = Map<RecType> | Array<RecType> | String

fn make_map() -> Map<RecType>
  Map([
    ("a", "b"),
  ])

pub fn main() -> i32
  let r: RecType = make_map()
  r.match(b)
    Map:
      b.get("a").match(v)
        Some:
          1
        else:
          -1
    else:
      -3
`;
