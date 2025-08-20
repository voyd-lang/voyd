export const closuresVoyd = `
use std::all

fn call_with_five(cb: (x: i32) -> i32) -> i32
  cb(5)

fn call_with_args(cb: (x: i32, y: i32) -> i32, x: i32, y: i32) -> i32
  cb(x, y)

fn call_with_reducer({ start: i32, reducer cb: (acc: i32, current: i32) -> i32 }) -> i32
  cb(start, 5)

fn call_it(v: i32, cb: (v: i32) -> i32)
  let hi: () -> i32 = () => cb(v)
  hi()

pub fn capture() -> i32
  let x = 41
  let add_closure = (y: i32) => x + y
  add_closure(1)

pub fn params() -> i32
  let add = (x: i32) => x + 5
  call_with_five(add)

pub fn param_infer_one() -> i32
  call_with_five(x => x + 5)

pub fn param_infer_two() -> i32
  call_with_args((x, y) => x + y, 3, 4)

pub fn param_infer_labeled() -> i32
  call_with_reducer start: 1 reducer: (acc, current) => acc + current

pub fn calls_closure() -> i32
  let sum = { val: 0 }
  let set: (v: i32) -> i32 = (v: i32) =>
    sum.val = v
    0
  call_it(4, set)
  sum.val

pub fn recursive() -> i32
  let sum: (n: i32) -> i32 = (n: i32) =>
    if n <= 1 then:
      n
    else:
      n + sum(n - 1)
  sum(5)

pub fn pipe() -> i32
  2
    .(x: i32) => x + 3
    .(x: i32) => x * 5
`;

