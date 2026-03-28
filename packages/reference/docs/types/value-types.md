---
order: 220
---

# Value Types

Use `val` for nominal fixed-layout types with value semantics.

```voyd
pub val Vec3 {
  x: f64,
  y: f64,
  z: f64
}
```

`val` declarations differ from `obj` in two important ways:

- `val` instances are copied on assignment, plain argument passing, and return.
- `val` instances do not have observable identity.

Choose `val` when the type is small or predictably fixed-layout and the program wants copied aggregate behavior instead of heap-object identity.

## Rules

- Fields must be layout-compatible. Valid field shapes include primitives, other value types, tuples and structural object fields, fixed arrays, unions and optionals of compatible members, and explicit heap/reference-like fields such as `obj`, trait, or function types.
- Recursive inline value layouts are rejected.
- `val` declarations cannot inherit from a base object.
- Mutable methods and mutable parameters still require `~self` or `~param`.
- Calling a mutable receiver on a temporary value is not allowed.
- Value types may satisfy trait bounds and participate in static dispatch, but they do not implicitly widen to trait objects.

## Copy And Mutation

```voyd
val Counter {
  value: i32
}

impl Counter
  fn bumped(self) -> Counter
    Counter { value: self.value + 1 }

  fn bump(~self) -> Counter
    self.value = self.value + 1
    self
```

`self` receives a copy. `~self` borrows existing storage and may mutate it.

## When To Use `val`

- Vectors, colors, rays, intervals, and similar math-heavy helpers.
- Small records embedded inside larger objects.
- Types that should compare and move as plain data.

Prefer `obj` when the type needs identity, recursive structure, shared mutable state, or regular trait-object use.
