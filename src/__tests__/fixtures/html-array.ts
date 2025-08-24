export const htmlArrayVoyd = `
use std::all

obj Box { val: i32 }

type Html = Array<Html> | String

fn work(html: Html, sum: i32) -> i32
  match(html)
    Array<Html>:
      let it = html.iterate()
      let reducer: (sum: i32) -> i32 = (sum: i32) -> i32 =>
        it.next().match(opt)
          Some<Html>:
            reducer(work(opt.value, sum))
          None:
            0
      reducer(sum)
    String:
      sum + 1

pub fn main() -> i32
  work([
    "hello",
    "world",
    ["how", "are", "we"]
  ], 0)
`;
