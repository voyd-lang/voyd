---
order: 20
---

# Syntax

Voyd is indentation-sensitive. Blocks use two-space indentation, and most code
reads as straightforward expression syntax rather than explicit delimiters.

## Blocks

An indented suite forms a block. The last expression becomes the block result.

```voyd
let total =
  let x = 2
  let y = 3
  x + y
```

## Calls

Standard calls use parentheses.

```voyd
add(1, 2)
```

Voyd also supports unparenthesized calls.

```voyd
fib n
clamp value min: 0 max: 10
```

Treat this as a readability tool for DSL-like code paths, not the default call
style. In most code, parenthesized calls remain easier to scan.

Method and UFCS-style calls use dot syntax.

```voyd
items.len()
1.add(2)
```

Module-qualified names use `::`.

```voyd
math::Vec3 { x: 1, y: 2, z: 3 }
```

## Clauses

Clause-based constructs use `:`.

```voyd
if count == 0:
  0
else:
  1

match(value)
  Some<i32> { value }:
    value
  None:
    0
```

Single-line `if` expressions use `then:`.

```voyd
let sign = if x < 0 then: -1 else: 1
```

## Single-expression forms

`=` is used when the right-hand side is a single expression.

```voyd
fn inc(x: i32) = x + 1
let answer = 42
```

## Lambdas

Lambdas use `=>`.

```voyd
let inc = (x: i32) => x + 1
let add = (x: i32) -> i32 => x + 1
```

## Literals

```voyd
let tuple = (1, "two")
let array = [1, 2, 3]
let object = { x: 1, y: 2 }
let value = "hello ${name}"
```

Nominal constructors pair a type name with object-literal or call syntax.

```voyd
User { id: 1, name: "Ada" }
Color(1, 2, 3)
```

## Subscripting and ranges

```voyd
let item = items[1]
items[1] = 99

let a = 0..5
let b = 0..=5
let c = 0..<5

let left = items[..2]
let right = items[2..]
let whole = items[..]
```

## Comments and doc comments

```voyd
// regular comment
/// declaration docs
//! module docs
```

See [Doc Comments](./doc-comments.md) for attachment rules.
