---
order: 60
---

# Modules

Voyd uses a file-and-folder based module system similar to modern Rust.
A module is defined by a file, and submodules are defined inside a directory of the same name.

Voyd's module system aims to be predictable, easy to navigate, and friendly to tooling.

---

# Defining Modules

## Module Layout

A module named `math` can be defined in either of these equivalent ways:

### **1. Single-file module**

```
src/math.voyd
```

### **2. Multi-file module**

```
src/math.voyd      // root of the math module
src/math/
  add.voyd         // submodule src::math::add
  sub.voyd         // submodule src::math::sub
```

If a directory exists with the module name, every file inside that directory becomes a submodule.

Package root: `pkg.voyd` is the package entry that defines what is exported to other packages (via `pub use` / top-level `pub` declarations). Other modules are normal: `pub` in those modules is only package-visible.
If `pkg.voyd` defines `pub fn main`, that function is the executable entry point; otherwise the package is a library.

---

# Examples

### From a file

```voyd
// src/internal.voyd
pub fn hey()
  "hey"
```

```voyd
// src/main.voyd
use src::internal

src::internal::hey()
```

### From a directory

```
src/
  internal.voyd
  internal/
    hey.voyd
```

`internal/hey.voyd` defines the module `src::internal::hey` automatically.
To expose a submodule from its parent, export it with `pub use self::<submodule-name>`.

```voyd
// src/internal.voyd
pub use self::hey  // export the module name
```

```voyd
// src/main.voyd
use src::internal::hey

src::internal::hey::hey()
```

If you want to re-export everything from the submodule (flattened into `internal`),
write `pub use self::hey::all`.

---

# **Inline Modules (the `mod` block)**

For small cases you may define modules directly inside a file:

```voyd
// src/main.voyd

mod internal
  pub fn hey()
    "hey"

self::internal::hey()
```

Inline modules behave exactly like file-based modules.

---

# **Module Imports (`use`)**

The `use` statement brings modules or items into scope.
Import paths must always start with one of these prefixes:
`self::`, `super::`, `src::`, `std::`, or `pkg::`.

```voyd
use src::my_module

src::my_module::hello()
```

## Selective imports

```voyd
use src::my_module::hello
hello()
```

## Group imports

```voyd
use src::my_module::{ self, a, b }
```

## Self-relative imports

Use `self::` to refer to submodules of the current module explicitly:

```voyd
use self::my_module
pub use self::my_module::all
```

## Renaming

```voyd
use src::my_module::hello as hi
```

## Importing all exports

```voyd
use src::my_module::all
```

`all` is reserved as the all-import selector. Module path segments cannot be named
`all` (for example, `src/all.voyd` and `src/util/all.voyd` are invalid).

## Parent-relative imports

Use `super::` to refer to modules relative to the parent module:

```voyd
use super::helpers
use super::helpers::math::all
```

## Standard library and package imports

```voyd
use std::log
use pkg::json
```

Installed packages are imported via `pkg::<package_name>`. The package root
module is `pkg.voyd`, which defines the public API with `pub use` and top-level
`pub` declarations.

The standard library is always installed as the `std` package. `std::...` is a
shortcut for `pkg::std::...`, so both paths resolve to the same modules and
exports from `std/pkg.voyd`.

```voyd
use std::{ some }
use pkg::json::{ encode }
```

Re-exporting a module from `my_lib/src/pkg.voyd` (e.g. `pub use self::my_submod`) makes
`use pkg::my_lib::my_submod` possible for consumers.

## Importing relative to the source root

```voyd
use src::logger
```

---

# Module Path Rules

Module paths behave like directory paths:

```
src::a::b::c
```

…represents the file `src/a/b/c.voyd` or directory `src/a/b/c/`.

### Examples

```
src/utils/hello/world.voyd   // You are here
src/utils/goodbye/jupiter.voyd
```

To import `jupiter`:

```voyd
use src::utils::goodbye::jupiter
```

---

# Relative Imports

Relative imports are explicit:

- `self::...` starts from the current module.
- `super::...` starts from the parent module (and may be repeated, e.g. `super::super::...`).
- Bare/unprefixed paths are invalid.

Example layout (self vs adjacent):

```
src/foo.voyd
src/foo/
  bar.voyd
src/baz.voyd
```

```voyd
// src/foo.voyd
use self::bar   // imports src::foo::bar
use src::baz    // imports src::baz
```

Example layout (siblings in the same directory):

```
src/utils/
  foo.voyd
  baz.voyd
```

```voyd
// src/utils/baz.voyd
use super::foo          // imports module src::utils::foo
use super::foo::all     // imports pub exports from src::utils::foo

src::utils::foo::id()
```

Use `src::...` (or `pkg::...`) to import from the package root explicitly.
If there is any ambiguity, prefer an explicit namespace.

---

# Visibility

Voyd is safe-by-default.

| Marker     | Meaning                                          |
| ---------- | ------------------------------------------------ |
| **(none)** | Private to the defining module                   |
| **pub**    | Package-visible (any module in the same package) |

Public API (visible to other packages) comes only from `pkg.voyd` exports. `pkg.voyd` is special: a `pub` item declared in `pkg.voyd` is public API, while `pub` elsewhere is only package-visible.

Members (the methods and fields of a type) have their own markers for added
safety

| Marker     | Meaning                                                    |
| ---------- | ---------------------------------------------------------- |
| **pri**    | Private to the type, only accessible from internal methods |
| **(none)** | Package visible when parent type is `pub`                  |
| **api**    | Eligible for public API (when the parent type is exported) |

Note that even if a type is exported from `pkg.voyd` only members marked with
`api` will be visible to other packages.

### **Examples (top-level)**

```voyd
pub fn package_func()    // Available to any module in the same package
fn private_func()        // Only inside this file/module
```

### **Examples (module-level `let`)**

```voyd
let answer = 41          // module-private binding
pub let pi = 3.14        // package-visible binding

pub fn main() -> f64
  pi + answer
```

Module-level `let` declarations are value bindings that can be referenced from
functions in the same module (or imported when declared `pub`).

Restrictions:

* Module-level `let` initializers must be pure.
* Mutable object binding syntax is not allowed at module scope:

```voyd
let ~cache = Dict<i32>::new()  // Error
```

### **Examples (objects)**

```voyd
pub obj Vec {
  api x: i32   // exportable field (still package-visible internally)
  y: i32       // package-visible internally
  pri z: i32   // explicitly private to the object
}

impl Vec
  api fn init(fill: i32)
    Vec { x: fill, y: fill, z: fill }
```

To expose `Vec` to other packages, export it from `pkg.voyd`:

```voyd
// my_lib/src/pkg.voyd
pub use src::vec::Vec
```

```voyd
// my_app/src/pkg.voyd
use pkg::my_lib::Vec

pub fn main()
  let v = Vec(1)
  v.x // Ok, x is part of the api
  v.y // Error, y is not part of the API
```
---

# Exporting From a Module

Exports are controlled with `pub use` (or shorthand `pub <module-expression>`). Use `self::` to target submodules explicitly.

### Export a submodule name

```voyd
pub use self::math
```

### Flatten a submodule into the parent

```voyd
pub use self::math::all
```

### Export a specific item from a submodule

```voyd
pub use self::math::{ add }   // exposes self::math::add
```

### Rename on export

```voyd
pub use self::math::{ mul as multiply }
```

### Export all public items from a submodule

```voyd
pub use self::strings::all
```

---

# Export Examples

```voyd
// src/lib.voyd

// Flatten math into this module
pub use self::math::all

// Export the submodule name
pub use self::sub

// Export mul as multiply
pub use self::mul::{ self as multiply }

// Export self::div::div as divide
pub use self::div::{ div as divide }

// Export and bring into this module’s scope
pub use self::strings::all

// Shorthand for `pub use self::json::encode`
pub self::json::encode
```

---

# More Complex Example

```
src/
  utils.voyd
  utils/
    vec.voyd
    logger.voyd
  server.voyd
  server/
    users/
      get_user.voyd
      add_user.voyd
    api.voyd
```

### **utils/vec.voyd**

```voyd
pub obj Vec {}

pub fn mul(a: Vec, b: Vec) -> Vec
```

### **utils/logger.voyd**

```voyd
use super::vec::{ Vec, mul }

pub fn log_vec()
  log Vec {}  // valid, Vec is imported from src::utils::vec

fn work()
  mul(Vec {}, Vec {})
```

### **server/users/get_user.voyd**

```voyd
use src::server::fetch  // valid: explicit root import
use super::api::start_api // error: resolves to src::server::users::api (does not exist)

pub fn get()
  fetch()
```

### **server/users/add_user.voyd**

```voyd
pub fn add()
  src::server::fetch()  // valid: fetch is exported
```

### **server/api.voyd**

```voyd
use super::users::get_user     // valid: sibling module users exports get_user
use super::users::add_user     // error: add_user is not exported

fn start_api()
  ...
```

---

# Module Keywords

### Module commands

* `pub` — Make top-level items package-visible (exports to other packages come from `pkg.voyd`)
* `mod` — Define an inline module
* `use` — Bring modules into scope

### Path keywords

* `all` — Import/export all `pub` items from a module
* `self` — Refer to the current module
* `super` — Refer to the parent module
* `std` — Standard library
* `src` — Source root
* `pkg` — Installed packages

### Reserved

* Modules cannot use keywords as names.
