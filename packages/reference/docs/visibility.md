---
order: 70
---

# Visibility

Voyd separates module visibility, package visibility, and public API export.

## Top-level declarations

By default, top-level declarations are module-private.

```voyd
fn helper() -> i32
  1
```

`pub` in an ordinary module makes the declaration package-visible.

```voyd
pub fn helper() -> i32
  1
```

Only `pkg.voyd` defines the public API that other packages can import.

```voyd
// pkg.voyd
pub use src::helpers::helper
```

## Members

Members inherit the visibility of their owning type inside the same package.

`pri` narrows a member to the owning object.

```voyd
pub obj Counter {
  value: i32,
  pri hidden: i32
}
```

`api` marks a field or method as exportable across package boundaries when the
owning type itself is part of the public API.

```voyd
pub obj Counter {
  api value: i32,
  hidden: i32
}

impl Counter
  api fn double(self) -> i32
    self.value * 2
```

External packages still cannot construct an exported nominal type with an
object literal when it has hidden or non-`api` fields, because those fields are
not visible at the call site.

Expose an `api fn init(...)` constructor when the public API should allow
construction without revealing internal fields.

```voyd
pub obj Counter {
  api value: i32,
  hidden: i32
}

impl Counter
  api fn init(value: i32) -> Counter
    Counter { value, hidden: 0 }
```

Rules of thumb:

- `pub` on a non-`pkg.voyd` item means package-visible, not globally public.
- `pub use` in `pkg.voyd` exports names to other packages.
- `api` is required for fields and methods that must remain visible outside the
  package.
- `pri` hides a member even from other code in the same package.
