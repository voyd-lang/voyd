export const htmlArrayVoyd = `
use std::all

obj Box { val: i32 }

type Html = Array<Html> | String

fn work(html: Array<Html>, sum: i32) -> i32
  let it = &html.iterate()
  let reducer: (sum: i32) -> i32 = (sum: i32) -> i32 =>
    it.next().match(opt)
      Some<Html>:
        opt.value.match(json)
          Array<Html>:
            reducer(work(json, sum))
          String:
            reducer(1 + sum)
      None:
        sum
  reducer(sum)

pub fn main() -> i32
  work([
    "hello",
    "world",
    ["how", "are", "we"]
  ], 0)
`;
