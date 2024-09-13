export const voidFile = `
use std::macros::all
use std::io::{ read, write: io_write }

fn fib(n: i32) -> i32
  if n <= 1 then:
    n
  else:
    fib(n - 1) + fib(n - 2)

macro_let extract_parameters = (definitions) =>
  \`(parameters).concat definitions.slice(1)

if x > 10 then:
  10
else:
  20

array.reduce(0, 1, 2) hey: () =>
  log val
  acc + val
with: () => 0

10
+ 3

mul(&self, other: Vec<T>)
mul(
  &self,
  other: Vec<T>
)

let a = array
  .reduce(0) (acc, val) =>
    acc + val
  + 10
  * 3

let x = my_func(
  add 1 2,
  () =>
    hello()
  ,
  3 + 4
)

closure_param_test(1, () => a, 3, () =>
  hey there,
  4,
  () => 5,
  () =>
    6,
  () =>
    7
  ,
  8
)

let (x, y) = (1, 2)

Array<Hey, There>(1, 2, 3) + 3

obj Test<T> {
  c: i32
}

fn test<T>(a: 1) -> i32

fn main()
  let a = ...test.hey + &other.now
  let x = 10 +
    20 +
    30

  let y = if x > 10
    then:
      10
    else:
      20

  let n =
    if args.len() > 1 then:
      console.log("Hey there!")
      args.at(1).parseInt().unwrap()
    else:
      10

  let x2 = 10
  let z = nothing()
  let a = hello.boop(1)
  let test_spacing = fib n
  let result = fib(n)
  let x = &hey
  $hey
  $@(hey)
  $(hey)
  $(extract equals_expr 2)
  (block $body)
  x + 5
  x + y + 10
  x * y + 10
  x()
  x

  let vec = {
    x: 10,
    y: Point { x: 10, y: 20 },
    z: { a: 10, b: 20 }
  }
`;

export const voidFileWithGenerics = `
use std::all

type DsArrayi32 = DsArray<i32>

pub fn main()
  let arr = ds_array_init<i32>(10)
  arr.set<i32>(0, 1)
  arr.get<i32>(0)
`;
