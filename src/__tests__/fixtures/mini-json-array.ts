export const miniJsonArrayVoyd = `
use std::all

pub obj JsonNull {}
pub obj JsonNumber: JsonNull { val: i32 }

type MiniJson = Array<MiniJson> | JsonNumber

fn work(val: Array<MiniJson>, sum: i32) -> i32
  let it = val.iterate()
  let reducer: (sum: i32) -> i32 = (sum: i32) -> i32 =>
    it.next().match(opt)
      Some<MiniJson>:
        opt.value.match(json)
          Array<MiniJson>:
            reducer(work(json, sum))
          JsonNumber:
            reducer(json.val + sum)
      None:
        sum
  reducer(sum)

pub fn main() -> i32
  work([
    JsonNumber { val: 23 },
    [
      JsonNumber { val: 10 }
    ]
  ], 0)
`;
