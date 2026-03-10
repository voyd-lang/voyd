---
order: 110
---

# Intrinsics

Intrinsics are compiler-recognized operations that back parts of the standard
library and code generator.

This page is primarily for std/compiler contributors. Most application code
should call standard-library wrappers instead of raw intrinsics.

## Declaring an intrinsic wrapper

Intrinsic wrappers use `@intrinsic`.

```voyd
@intrinsic(name: "__array_len")
fn len<T>(arr: FixedArray<T>) -> i32
  __array_len(arr)
```

`@intrinsic` also supports `uses_signature: true` when the declared signature
should remain authoritative during typing.

## Scope

Current intrinsic support covers:

- arithmetic and comparison operators
- boolean operators
- std-only `__*` helpers for arrays
- std-only numeric conversion helpers
- low-level runtime/type helpers used by the compiler and std

Raw `__*` intrinsic names are reserved for the standard library. Non-std
packages should use the corresponding std APIs instead of declaring their own
`__*` wrappers.

## Intrinsic types

Some internal std/compiler declarations also use `@intrinsic_type` metadata.
Like `@intrinsic`, this is not ordinary application-level surface area.
