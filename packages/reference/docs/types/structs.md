---
order: 220
---

# Structs

Voyd supports nominal fixed-layout value structs through `value` declarations.

```voyd
pub value Vec3 {
  x: f64,
  y: f64,
  z: f64
}
```

Use `value` when a type should behave like a copied aggregate instead of a heap
object with identity.

Today:

- use `value` for small fixed-layout data such as vectors, colors, rays, and intervals
- use tuples for anonymous fixed-position values
- use `obj` when the type needs identity, recursive structure, or heap-oriented behavior

Current `value` rules:

- fields must have statically known layout
- fields may contain primitives, other values, tuples, fixed arrays, and explicit heap/reference types
- recursive value layouts are rejected
- value types may implement traits for static dispatch, but they do not implicitly widen to trait objects

Earlier `%{ ... }` and `%(... )` notes referred to older structural value syntax.
That syntax is still reserved; the supported surface today is nominal `value`.
