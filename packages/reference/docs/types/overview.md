---
order: 200
---

# Types Overview

Voyd combines structural typing, nominal typing, traits, unions, and effects.

## Primitive types

The currently exercised primitive scalar types are:

- `i32`
- `i64`
- `f32`
- `f64`
- `bool`

Strings, arrays, tuples, objects, traits, and effects build on top of those
primitives and runtime-provided reference types.

## Structural and nominal data

- Structural object types describe shape: `type Point = { x: i32, y: i32 }`
- Nominal object types describe identity: `obj User { id: i32 }`
- Tuples describe ordered fixed-size values: `(i32, String)`
- Unions describe one-of-many values
- Intersections describe values that must satisfy multiple requirements

## Next chapters

- [Objects](./objects.md)
- [Tuples](./tuples.md)
- [Enums](./enums.md)
- [Unions](./unions.md)
- [Intersections](./intersections.md)
- [Traits](./traits.md)
- [Effects](./effects.md)
- [Structs](./structs.md)
