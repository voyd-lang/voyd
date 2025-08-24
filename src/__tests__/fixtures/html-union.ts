export const htmlUnionVoyd = `
use std::all

type Html = Array<Html> | String

fn work(html: Html, sum: i32) -> i32
  match(html)
    Array<Html>:
      let it = &html.iterate()
      let reducer: (acc: i32) -> i32 = (acc: i32) -> i32 =>
        it.next().match(opt)
          Some<Html>:
            reducer(work(opt.value, acc))
          None:
            acc
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
