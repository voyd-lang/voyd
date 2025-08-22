export const mapGetSomeVoyd = `
use std::all

pub fn run() -> i32
  let m = new_map<i32>()
  m.set("a", 1)
  m.get("a").match(v)
    Some<i32>:
      v.value
    None:
      0
`;
