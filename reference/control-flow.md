# Control Flow

## If

If expressions support any number of `elif` branches and an optional `else`.

```voyd
if x < 0 then: -1
elif: x < 10 then: 0
else: 1
```

When the `else` branch is omitted, the result of the expression is `voyd`.

## Match

Used to narrow types. Can operate on object to narrow
child objects or on unions to narrow union members

Signature(s):
```
fn match<T extends Object, U>(val: T, body: MatchBlock) -> U
fn match<T extends Object, U>(val: T, bind_identifier: Identifier, body: MatchBlock) -> U
```

Example:
```voyd
obj Optional

obj None: Optional

obj Some: Optional {
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
    Some: "The value is ${x}"
    None: "Error: divide by zero"
    else: "Bleh"
```

The second signature of match is useful when the value being matched against
is not already bound to an identifier (i.e. dot pipelines):
```voyd
fn main(a: i32, b: i32) -> String
  a.divide(b)
    .match(x) // Here, match binds the result of the previous expression to x
      Some: "The value is ${x}"
      None: "Error: divide by zero"
```
