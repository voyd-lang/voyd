---
order: 30
---

# Control Flow

## If

Examples

```voyd
// Standard if statement
if x < 0:
  -1
else:
  1

// With multiple conditions (else if clauses)
if
  x < 0:
    -1
  x > 5:
    0
  else:
    1

// As an expression
let x =
  if
    x < 0:
      -1
    x > 5
      0
    else:
      1

// One line expressions need `then:` and do not support multiple conditions
let x = if x < 0 then: -1 else: 2
```

## Loops

```voyd
// Standard while loop
while cond:
  foo()

// For loop. Works on anything that implements the Sequence trait, such as Array
for item in [1, 2, 3]:
  foo(item)
```

## Match

`match` is an expression that branches on a value using a list of pattern arms.

```voyd
match(value)
  Pattern1: expr1
  Pattern2:
    expr2
  else: default_expr
```

Match arm bodies can be written inline (`Pattern: expr`) or as an indented suite
(`Pattern:` followed by a block).

### Patterns

Supported pattern forms include:

- `else` (wildcard)
- Type tests: `Dog`
- Type + bind whole value: `Dog as d`
- Type + destructure fields:

```voyd
match(pet)
  Dog { noses }: noses + 2
  Cat { lives: l }: l
```

- Tuple patterns:

```voyd
(a, b): a + b
```

- Nested patterns:

```voyd
Some { v: (a, b) }: a * 10 + b
```

Match arm types must be compatible with the overall match expression type. When
used as a statement (e.g., inside a loop body), both a value-level `void` and
`break` satisfy `void` cases.

### Omitting Type Parameters in Type Arms

When matching against a union, you can omit generic type parameters in a case
label if the referenced object appears exactly once among the union variants.
This removes redundancy while remaining unambiguous.

Example: `Optional<T> = Some<T> | None` has only one `Some` variant, so you can
write:

```voyd
use std::all
use std::optional::Optional

fn main() -> i32
  let ~m = Dict<i32>::new()
  m.set("hey", 5)
  m.set("bye", 1)
  match(m.get("hey"))
    Some: 1   // OK: `Some` appears once in Optional<T>
    None: -1
```

If the same head appears multiple times in the union (e.g., `Some<A> | Some<B>`),
you must specify the type parameters to disambiguate: `Some<A>:`.

## `if` as `match` Shorthand

An `if/elif/else` chain is lowered as a `match` when all conditions are type
tests (`is`) of the same identifier and an `else` branch exists:

```voyd
if
  pet is Dog:
    pet.noses
  pet is Cat:
    pet.lives
  else:
    0
```

This is equivalent to a `match(pet)` with type patterns plus a wildcard arm.

## Value-level `void`

Voyd provides a value-level placeholder `void` usable in expression position
whenever you need to produce no value (historically this was done with `0`).
This compiles to a no-op and type-checks as `voyd`, which is compatible with
`void` return types.

```voyd
fn noop() -> void
  void
```

## `break` type

`break` is treated as a `void`-typed expression. This allows using `break`
inside expression contexts such as match arms without adding filler values.

```voyd
while cond:
  match(x)
    CaseA: void   // any void-like work
    CaseB: break  // exits the loop; type-checks as void
```
