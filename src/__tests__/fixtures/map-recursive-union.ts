export const mapRecursiveUnionVoyd = `
use std::all

pub type RecType = Map<RecType> | Array<RecType> | String

fn a() -> RecType
  Map([
    ("a", "b"),
  ])

pub fn main() -> i32
  let r = a()
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

