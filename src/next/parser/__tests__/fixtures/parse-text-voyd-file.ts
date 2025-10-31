import { CharStream } from "../../char-stream.js";

export const parseFileVoydText = `
fn fib(n: i32) -> i32
  if n <= 1 then:
    n
  else:
    fib(n - 1) + fib(n - 2)

fn main()
  let x = 10 +
    20 +
    30

  let y = if x > 10
    then:
      10
    else:
      20

  call this while () => if x > 10 then:
    x -= 1
  else:
    x += 1

  let n = if args.len() > 1 then:
    console.log("Hey there!")
    args.at(1).parseInt().unwrap()
  else:
    10

  let x2 = 10
  let z = nothing()
  let test_spacing = fib n
  let result = fib(n)
`;

export const voydFile = new CharStream(parseFileVoydText, "beep/boop");
