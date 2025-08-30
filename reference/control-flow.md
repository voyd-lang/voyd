# Control Flow

## If

If expressions support any number of `elif` branches and an optional `else`.

```voyd
if x < 0 then: -1
elif: x < 10 then: 0
else: 1
```

When the `else` branch is omitted, the result of the expression is `voyd`.

### Value-level `void`

Voyd provides a value-level placeholder `void` usable in expression position
whenever you need to produce no value (historically this was done with `0`).
This compiles to a no-op and type-checks as `voyd`, which is compatible with
`void` return types.

```voyd
fn noop() -> void
  void
```

### `break` type

`break` is treated as a `void`-typed expression. This allows using `break`
inside expression contexts such as match arms without adding filler values.

```voyd
while cond do:
  match(x)
    CaseA: void   // any void-like work
    CaseB: break  // exits the loop; type-checks as void
```

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

Match arm types must be compatible with the overall match expression type.
When used as a statement (e.g., inside a loop body), both a value-level
`void` and `break` satisfy `void` cases.

The second signature of match is useful when the value being matched against
is not already bound to an identifier (i.e. dot pipelines):
```voyd
fn main(a: i32, b: i32) -> String
  a.divide(b)
    .match(x) // Here, match binds the result of the previous expression to x
      Some<i32>: "The value is ${x}"
      None: "Error: divide by zero"
```

## Pattern Matching Sugar

voyd provides some features to make pattern matching more ergonomic in places where using a match would be a bit awkward

```voyd
let opt = Some { value: 4 }

// If match, useful when you don't care about exhaustiveness
if opt.match(Some<i32>) then:
  opt.value

// Match can also optionally bind to a new variable name
if opt.match(x, Some<i32>) then:
  x.value

// Works for while loops too
let a = [1, 2, 3]
let iterator = a.iterate()

var sum = 0
while iterator.next().match(x, Some<i32>) do:
  sum = sum + x

// Optional<T> specific sugar


let structure = {
  a: some {
    b: some {
      c: 5
    }
  }
}

// Optional coalesce
let value: Some<i32> = a?.b?.c // 5

if x := opt then:
  x // x is i32 here, not Some<i32>

while n := iterator.next() do:
  sum = sum + n

// Iterator specific sugar

while n in [1, 2, 3] do:
  sum = sum + n
```
