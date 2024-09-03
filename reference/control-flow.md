# Control Flow

## Match

Used to narrow types. Can operate on object to narrow
child objects or on unions to narrow union members

Signature(s):
```
fn match<T extends Object, U>(val: T, body: MatchBlock) -> U
fn match<T extends Object, U>(val: T, bind_identifier: Identifier, body: MatchBlock) -> U
```

Example:
```void
obj Optional

obj None extends Optional

obj Some extends Optional {
  value: i32
}

fn divide(a: i32, b: i32) -> Optional
  if b == 0
    None {}
  else:
    Some { value: a / b }

fn main(a: i32, b: i32) -> String
  let x = a.divide(b)
  match(x)
    Some => "The value is ${x}"
    None => "Error: divide by zero"
    else "Bleh"
```

The second signature of match is useful when the value being matched against
is not already bound to an identifier (i.e. dot pipelines):
```void
fn main(a: i32, b: i32) -> String
  a.divide(b)
    .match(x) // Here, match binds the result of the previous expression to x
      Some => "The value is ${x}"
      None => "Error: divide by zero"
```
