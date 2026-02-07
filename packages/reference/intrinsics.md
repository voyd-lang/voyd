# Intrinsics

Intrinsics are built-in operations implemented by the compiler or runtime rather
than in userland Voyd code. They expose low-level capabilities (numeric ops,
array primitives, GC helpers) while still fitting into Voyd's type system and
codegen pipeline.

## How intrinsics are recognized

- Intrinsic status lives on symbol metadata. Functions become intrinsic by being
  annotated with `@intrinsic`.
- `@intrinsic` supports optional arguments:
  - `name`: the low-level intrinsic identifier to call. Defaults to the function
    name.
  - `uses_signature`: when `true`, the function types/validates using its
    declared signature (the body can call the intrinsic); when omitted/`false`,
    the call bypasses the signature and is validated by intrinsic rules
    (arity/type checks).
- Example wrappers:

```voyd
// Raw intrinsic: validated by intrinsic rules, body is ignored by typing/codegen.
@intrinsic(name: "__array_len")
fn len<T>(arr: FixedArray<T>) -> i32 __array_len(arr)

// Wrapper that uses the declared signature/body but keeps intrinsic metadata.
@intrinsic(name: "__array_get", uses_signature: true)
fn get<T>(arr: FixedArray<T>, index: i32) -> T
  __array_get(arr, index)
```

## Available intrinsics

The following intrinsic names are recognized by typing and codegen:

- Numeric arithmetic: `+`, `-`, `*`, `/` (i32, i64, f32, f64)
- Numeric comparisons: `<`, `<=`, `>`, `>=` (i32, i64, f32, f64)
- Equality: `==`, `!=` (i32, i64, f32, f64, bool)
- Fixed-array primitives:
  - `__array_new<T>(size: i32) -> FixedArray<T>`
  - `__array_new_fixed<T>(elements...) -> FixedArray<T>`
  - `__array_get<T>(array: FixedArray<T>, index: i32, [elementType, signed?]) -> T`
  - `__array_set<T>(array: FixedArray<T>, index: i32, value: T) -> FixedArray<T>`
  - `__array_len<T>(array: FixedArray<T>) -> i32`
  - `__array_copy<T>(dest: FixedArray<T>, srcIndex: i32, src: FixedArray<T>, srcOffset: i32, count: i32) -> FixedArray<T>`
    or options form with `from`, `to_index`, `from_index`, `count`
- GC/type helpers:
  - `__type_to_heap_type(type) -> heapref`

## Authoring and using intrinsic wrappers

- Mark wrappers in any module with `@intrinsic`; the metadata flows through
  binding, lowering, typing, and codegen.
- For `uses_signature: true`, provide a normal Voyd signature/body—the compiler
  will type-check calls against it and still emit intrinsic code.
- For raw intrinsics (`uses_signature` omitted/false), calls must satisfy the
  intrinsic's arity and type rules regardless of the wrapper's signature/body.
- Intrinsic functions are not exported when compiling modules; they are
  consumed internally or via wrappers marked intrinsic.
