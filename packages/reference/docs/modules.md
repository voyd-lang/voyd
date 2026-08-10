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

An ordinary module may be the facade for a folder without creating a package
boundary. For example, `math.voyd` can re-export declarations from
`math/vec3.voyd`; both files still belong to the same package.

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

The exception is a nominal union or enum alias already in scope. Its member
namespace can be imported directly, whether the alias is local or imported.

```voyd
use src::drinks::{ Drink }
use Drink::{ Coffee, Tea }
use Drink::all
```

For a locally declared enum, its variant names are already in the declaring
module's scope; importing them again is accepted as an idempotent namespace
selection and is mainly useful for consistency or re-export declarations.

Effect operations can also be selected through an effect namespace. Selecting
`all` imports every operation owned by that effect; a grouped selection imports
only the named operations.

```voyd
use src::articles::ArticleStorage::all
use src::audit::{ AuditLog::{ record_change } }
```

These imports make the selected operations available as unqualified calls.
They do not import the owning effect name, so import that separately when it is
also needed in an effect row or qualified call. A module-wide `module::all`
import continues to exclude effect operations.

### Exact `all` behavior

`module::all` selects one level of the module's exported symbol table. It does
not recursively flatten child modules. It includes exported values, functions,
overload sets, types, traits, effects, macros, and top-level operator symbols.
Associated fields and methods remain accessed through their owning type, and
trait-implementation metadata follows the exported type or trait instead of
becoming a standalone name.

Effect operations are the exception: module `all` does not flatten them. Use
`EffectName::all` or select operations from the effect namespace explicitly.

An effect namespace is distinct from its declaring module. This lets a module
offer a typed wrapper with the same natural name as the raw operation:

```voyd
use std::fs
use std::fs::Fs

fs::rename(source, to: destination)
Fs::rename(payload)
```

After `module::member`, Voyd searches only ordinary exports. After
`Effect::member`, it searches only operations declared by that effect. There is
no fallback between the two namespaces. Effect aliases preserve the declaring
effect and operation identity. Select an operation explicitly with
`use Effect::member`, `use Effect::member as alias`, or `use Effect::all` when an
unqualified call is desired; an ordinary `use module::all` never introduces raw
effect operations.

An explicit `pub use Effect::member as alias` may carry an operation through a
facade for later explicit unqualified selection. It does not add
`facade::alias(...)` to the module-qualified call namespace.

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
their own exports. The physical `pkg` segment is omitted from the logical import
path:

```text
src/
  geometry/
    pkg.voyd       # logical path: src::geometry
    vector.voyd    # internal path: src::geometry::vector
```

```voyd
// geometry/pkg.voyd
pub use self::vector::{ Vec2, '+' }

// consumer
use src::geometry::all
```

That means:

- exported items remain accessible through the nested package root
- code outside the subpackage, including its parent package, has no privileged
  access to internals
- `pub` declarations in internal files stay package-private until the package
  root re-exports them
- non-`api` members on exported types stay hidden across that boundary
- macro-generated declarations obey the visibility they emit, just like
  handwritten declarations

Use an ordinary `foo.voyd` facade when the folder is an organizational detail
inside one package. Use `foo/pkg.voyd` when `foo` needs an enforced API boundary
with isolated internals.

### Conflicting layouts

`foo.voyd` and `foo/pkg.voyd` cannot coexist. Both claim the logical path
`foo`, so compilation reports an ambiguity naming both files. Keep the ordinary
facade or remove it and use the nested package root; Voyd never chooses one by
precedence.

### Operators, traits, and macros

Top-level operator declarations are ordinary exported symbols. Re-export them
from `pkg.voyd`, then select them explicitly or through `all` at the use site.
If an operator is available from a facade but was omitted from a selective
import, the diagnostic points to that facade and recommends importing the
operator or its `all` surface.

An `api` operator or method declared in an `impl` follows its exported owning
type. Trait declarations and applicable implementation metadata retain their
canonical identity through re-exports. When a separately declared trait
implementation is present in an imported module but its owning type or trait
was not selected from that surface, import the owner from the indicated facade.

Macros follow the same package path rules. `pub macro` makes a macro available
to its package; a nested package root must re-export it for outside callers.
`module::all` includes exported macros, while a non-`pub` macro remains
module-private.

## Migrating a facade to a source package

Suppose an ordinary facade starts as:

```text
src/
  geometry.voyd
  geometry/
    vector.voyd
```

```voyd
// geometry.voyd
pub use self::vector::{ Vec2, '+' }
```

To establish a package boundary:

1. Move the facade to `geometry/pkg.voyd`; do not leave `geometry.voyd` in
   place.
2. Re-export the intended surface from the package root with paths anchored at
   `self`, such as `pub use self::vector::{ Vec2, '+' }`.
3. Keep consumer imports at the logical path `src::geometry`; never write the
   physical `pkg` segment.
4. Add `api` only to fields and methods that outside packages must access.
5. Import top-level operators or traits explicitly, or use the curated package
   `all` surface.

Common migration diagnostics identify the smallest repair:

| Diagnostic | Repair |
| --- | --- |
| module-private declaration | Add `pub` if sibling modules should use it. |
| package-private declaration | Re-export it from `geometry/pkg.voyd` if it belongs in the API. |
| hidden nested-package internal | Import from `src::geometry`; add a root re-export when intended. |
| member requires `api` | Add `api` to that field or method, or expose a public operation instead. |
| macro present but not exported | Add `pub` to the macro and re-export it from the root. |
| operator or trait implementation not imported | Select the named operator, owning type, or trait from the reported facade. |
| `geometry.voyd` conflicts with `geometry/pkg.voyd` | Keep exactly one logical-path owner. |

## CLI entrypoints

The CLI treats a directory input as an entry root and resolves `main.voyd`
first, then `pkg.voyd`.
