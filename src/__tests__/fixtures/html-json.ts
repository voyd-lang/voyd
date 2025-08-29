export const htmlJsonVoyd = `
use std::all

// Shared union type for HTML-like values
type Html = Array<Html> | String

// 1) Work over Array<Html>
fn work_html_array(html: Array<Html>, sum: i32) -> i32
  let it = html.iterate()
  let reducer: (sum: i32) -> i32 = (sum: i32) -> i32 =>
    it.next().match(opt)
      Some<Html>:
        opt.value.match(json)
          Array<Html>:
            reducer(work_html_array(json, sum))
          String:
            reducer(1 + sum)
      None:
        sum
  reducer(sum)

pub fn test1() -> i32
  work_html_array([
    "hello",
    "world",
    ["how", "are", "we"]
  ], 0)

// 2) Work over Html union directly
fn work_html_union(html: Html, sum: i32) -> i32
  match(html)
    Array<Html>:
      let it = html.iterate()
      let reducer: (acc: i32) -> i32 = (acc: i32) -> i32 =>
        it.next().match(opt)
          Some<Html>:
            reducer(work_html_union(opt.value, acc))
          None:
            acc
      reducer(sum)
    String:
      sum + 1

pub fn test2() -> i32
  work_html_union([
    "hello",
    "world",
    ["how", "are", "we"]
  ], 0)

// 3) Mini-JSON array recursion/widening
pub obj JsonNull {}
pub obj JsonNumber: JsonNull { val: i32 }

type MiniJson = Array<MiniJson> | JsonNumber

fn work_mini(val: Array<MiniJson>, sum: i32) -> i32
  let it = val.iterate()
  let reducer: (sum: i32) -> i32 = (sum: i32) -> i32 =>
    it.next().match(opt)
      Some<MiniJson>:
        opt.value.match(json)
          Array<MiniJson>:
            reducer(work_mini(json, sum))
          JsonNumber:
            reducer(json.val + sum)
      None:
        sum
  reducer(sum)

pub fn test3() -> i32
  work_mini([
    JsonNumber { val: 23 },
    [
      JsonNumber { val: 10 }
    ]
  ], 0)
`;

