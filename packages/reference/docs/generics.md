---
order: 50
---

# Generics

Generics let declarations abstract over types.

```voyd
fn id<T>(value: T) -> T
  value
```

Generic parameters are supported on:

- functions
- type aliases
- objects
- traits
- impl blocks
- effects

## Explicit and inferred arguments

Type arguments are often inferred.

```voyd
fn pair<T>(value: T) -> (T, T)
  (value, value)

pair(3)
```

You can also pass them explicitly.

```voyd
pair<i32>(3)
```

## Constraints

Use `T: ...` to constrain a type parameter.

```voyd
fn render<T: Drawable>(value: T) -> String
  value.draw()
```

Supported constraint shapes include:

- trait constraints
- nominal constraints
- structural constraints
- intersections of those constraints

```voyd
fn load<T: Cacheable & { key: String }>(value: T) -> String
  value.key
```

## Generic declarations

```voyd
type Box<T> = { value: T }

obj Result<T, E> {
  value: T,
  error: E
}

trait Decoder<T>
  fn decode(self, source: String) -> T

impl<T: Drawable> Widget<T>
  fn draw(self) -> String
    self.value.draw()
```

## Effects and generics

Effect rows can also be generic. See [Effects](./types/effects.md) for details
on `effects` parameters and row polymorphism.
