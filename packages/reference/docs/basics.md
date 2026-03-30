---
order: 10
---

# Basics

## Comments

```voyd
// Single-line comment
```

## Bindings

`let` creates an immutable binding. `var` creates a reassignable binding.

```voyd
let answer = 41
var count = 0

count = count + 1
```

## Functions

Functions use `fn`. The last expression in the body is the result.

```voyd
fn add(a: i32, b: i32) -> i32
  a + b

fn inc(x: i32) = x + 1
```

## Literals

```voyd
let int_value = 5
let float_value = 3.14
let ok = true
let name = "Voyd"
let pair = (1, "two")
let items = [1, 2, 3]
```

String interpolation uses `${...}`.

```voyd
let user = "Ada"
let greeting = "Hello, ${user}"
```

Escape `\${` when you want the literal text.

```voyd
let template = "Hello, \${name}"
```

## Structural object literals

```voyd
let point = {
  x: 3,
  y: 4
}

let x = point.x
```

Field shorthand works when the binding name already matches the field name.

```voyd
let x = 3
let y = 4
let point = { x, y }
```

## Tuples

```voyd
let pair = (1, "two")

let first = pair.0
let second = pair.1

let (a, b) = pair
```

## Nominal objects

Use `obj` when the type should have its own identity instead of being satisfied
by any structurally compatible value.

```voyd
obj User {
  id: i32,
  name: String
}

let user = User { id: 1, name: "Ada" }
```

## Expressions

Most constructs in Voyd are expressions, including blocks, `if`, and `match`.

```voyd
let sign =
  if answer > 0:
    1
  else:
    -1

let total =
  let x = 2
  let y = 3
  x + y
```

## Control flow

```voyd
if count == 0:
  print("empty")
else:
  print("ready")

while count < 3:
  count = count + 1

for value in 0..3:
  print(value)
```

`match` destructures values by shape.

```voyd
match(user)
  User { name }:
    name
  else:
    "unknown"
```

## Ranges and subscripts

Ranges are expressions and are commonly used in `for` loops and slicing.

```voyd
let half_open = 0..5
let inclusive = 0..=5

let items = [10, 20, 30, 40]
let second = items[1]
let middle = items[1..3]
```

See [Syntax](./syntax.md), [Functions](./functions.md), and
[Control Flow](./control-flow.md) for the full rules.
