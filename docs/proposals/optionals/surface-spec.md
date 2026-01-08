# Optional Fields & Parameters (`?`) — Surface Syntax & Semantics

## Summary

Voyd supports optional object fields and optional function parameters using `?`.

- `field?: T` / `param?: T` means the value may be omitted at the construction/call site and defaults to `None`.
- The value representation is `Optional<T>` (defined in the standard library as `Some<T> | None`).
- The *ability to omit* is **not inferred from the type**. Only fields/params explicitly marked with `?` may be omitted.

---

## Standard Library Requirement

The standard library defines:

```voyd
obj Some<T> { value: T }
obj None {}
type Optional<T> = Some<T> | None
```

Codegen test fixtures do not import std, so they must define these three items locally.

---

## Syntax

### Optional object fields

```voyd
obj OptionalBox { v?: i32 }
```

### Optional function parameters

```voyd
fn work(id: i32, middle?: i32) -> i32
  match(middle)
    Some<i32>: middle.value
    None: 0
```

### Optional labeled parameters (parameter object)

```voyd
fn f({ title: i32, subtitle?: i32 }) -> i32
  ...
```

### Optional parameters in function type expressions

```voyd
fn apply(cb: fn(middle?: i32) -> i32) -> i32
  cb()
```

This must remain distinct from:

```voyd
fn apply(cb: fn(Optional<i32>) -> i32) -> i32
  cb() // error: arg is required (no `?`)
```

---

## Semantics

### 1) Desugaring of `?` into `Optional<T>`

For fields/params declared with `?`:

- The declared type `T` is treated as `Optional<T>`.
- The declaration also records an `optional: true` flag that controls omission rules (i.e. `?` is not “just syntax for `Optional<T>`”).

### 2) Omission rules

- If a field/parameter is marked `?`, it may be omitted.
- If it is not marked `?`, it must be provided, even if its type is `Optional<T>`.

### 3) Default value for omitted optionals

Omitted optionals default to `None {}` (typed as `Optional<T>`).

### 4) Implicit wrapping (`T` → `Optional<T>`)

When an expression of type `T` is used where `Optional<T>` is expected, the compiler inserts:

```voyd
Some<T> { value: <expr> }
```

If the expression is already `Optional<T>`, it is passed through unchanged.

### 5) Calls: positional + labeled interactions

When normalizing arguments against parameters:

- Missing optional positional parameters may be filled with `None` even if later labeled arguments are present (e.g. `sum(1, c: 2)` where `b?: i32` is skipped).
- Extra arguments are rejected.
- Missing required (non-`?`) arguments are rejected.

### 6) Higher-order function typing

Optionality is part of the function *signature*:

- A function that requires a parameter is **not** assignable to a type where that parameter is optional, because the caller may omit it.
- A function whose parameter is optional may be assignable to a required-arg function type (subject to the language’s function variance rules).

---

## Diagnostics (User-facing requirements)

- Calling a function with too many arguments: “extra arguments (N)”.
- Calling a function missing a required positional argument: “missing argument for parameter X”.
- Calling a function missing a required labeled argument: “missing labeled argument `name:`”.
- Calling with no args when the function expects a required arg (even if its type is `Optional<T>`): must error.

