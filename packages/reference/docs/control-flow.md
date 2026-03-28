---
order: 30
---

# Control Flow

## `if`

`if` is an expression.

```voyd
let sign =
  if x < 0:
    -1
  else:
    1
```

Multi-branch `if` chains use clause form.

```voyd
if
  x < 0:
    -1
  x > 0:
    1
  else:
    0
```

If can also be used to narrow types.

```voyd
if
  pet is Dog:
    pet.noses
  pet is Cat:
    pet.lives
  else:
    0
```

This is a concise surface form for branching on repeated type tests of the same
value. Use `match` when destructuring is the main point.

Single-line `if` expressions use `then:`.

```voyd
let sign = if x < 0 then: -1 else: 1
```

## `while`

```voyd
while count < 10:
  count = count + 1
```

## `for`

`for` works over values that implement `Sequence<T>`.

```voyd
for item in [1, 2, 3]:
  log(item)

for value in 0..5:
  log(value)
```

Supported range forms include:

- `a..b`
- `a..=b`
- `a..<b`
- `..b`
- `..=b`
- `a..`
- `..`

## `match`

`match` is an expression that branches by pattern.

```voyd
match(value)
  Some<i32> { value }:
    value
  None:
    0
```

Supported pattern shapes include:

- nominal type arms such as `Dog`
- type arms with a whole-value binding such as `Dog as dog`
- object destructuring such as `Dog { age }`
- tuple destructuring such as `(x, y)`
- nested patterns
- `else`

When matching a generic union, you may omit type arguments in a case label when
the variant head is unique within the union.

```voyd
match(result)
  Some { value }:
    value
  None:
    0
```

## `void` and `break`

`void` is the value-level placeholder for “no value”.

```voyd
fn log_only() -> void
  void
```

`break` is valid in expression positions that expect `void`.

```voyd
while true:
  match(next())
    None:
      break
    Some<i32> { value }:
      log(value)
```
