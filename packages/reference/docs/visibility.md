---
order: 70
---

# Visibility

Voyd separates module visibility, package visibility, and public API export.

## Visibility matrix

| Declaration | Declaring module | Same package | Outside package |
| --- | --- | --- | --- |
| top-level, no modifier | yes | no | no |
| top-level `pub` in an ordinary module | yes | yes | no |
| top-level `pub` or `pub use` exported by `pkg.voyd` | yes | yes | yes |
| member, no modifier | yes when its owner is visible | yes when its owner is visible | no |
| `pri` member | owning object only | no | no |
| `api` member on an exported owner | yes | yes | yes |
| macro, no modifier | yes | no | no |
| `pub macro` | yes | yes | only when exported by `pkg.voyd` |

A nested source package has its own “same package” column. Its parent package is
an outside consumer and cannot reach nested internals directly.

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

For a nested `src/foo/pkg.voyd`, public consumers use the logical path
`src::foo`; the physical `pkg` segment never appears in the import. A `pub`
declaration in `src/foo/internal.voyd` remains private to the `foo` package until
`src/foo/pkg.voyd` re-exports it.

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

Operators declared as top-level functions use top-level visibility and must be
selected like other exported symbols. Operators and methods declared inside an
`impl` use member visibility, so external use requires `api` when the owning
type crosses a package boundary.

Generated declarations use the visibility emitted by their macro. A generated
`pub` declaration in an internal module remains package-private, and a nested
package root must re-export it for external callers. Hygienic fresh helper names
remain private implementation details.

Rules of thumb:

- `pub` on a non-`pkg.voyd` item means package-visible, not globally public.
- `pub use` in `pkg.voyd` exports names to other packages.
- `api` is required for fields and methods that must remain visible outside the
  package.
- `pri` hides a member even from other code in the same package.
