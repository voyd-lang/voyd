---
order: 60
---

# Modules

Voyd uses a file-and-folder module system.

## Module layout

```text
src/
  main.voyd
  math.voyd
  math/
    vec3.voyd
```

- `math.voyd` defines `src::math`
- `math/vec3.voyd` defines `src::math::vec3`

Inline modules are also supported.

```voyd
mod math
  pub fn one() -> i32
    1
```

## Imports

Import paths start with one of:

- `self::`
- `super::`
- `src::`
- `std::`
- `pkg::`

Examples:

```voyd
use src::math
use src::math::vec3::Vec3
use src::math::{ self, add, sub }
use src::math::add as plus
use src::math::all
```

Bare paths are not valid in `use` declarations.

## Re-exports

Use `pub use` to re-export names.

```voyd
pub use self::vec3
pub use self::vec3::all
pub use src::math::{ Vec3, dot }
```

You can also use `pub` without use to re-export without bringing the
exported item into module scope.

```voyd
pub self::vec3
pub self::vec3::all
pub src::math::{ Vec3, dot }
```

## Package boundaries

`pkg.voyd` defines the public API of a package.

- In ordinary modules, `pub` means package-visible.
- In `pkg.voyd`, exported `pub` declarations and `pub use` re-exports form the
  public package surface.

Consumers import public package APIs through `pkg::name::...` or `std::...`.

```voyd
use pkg::json::encode
use std::optional::all
```

## Source-level subpackages

Nested `src/**/pkg.voyd` files define source-level package boundaries with
their own exports.

That means:

- exported items remain accessible through the nested package root
- non-exported internals stay hidden outside that subpackage
- non-`api` members on exported types stay hidden across that boundary

## CLI entrypoints

The CLI treats a directory input as an entry root and resolves `main.voyd`
first, then `pkg.voyd`.
