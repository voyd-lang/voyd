# **📦 Modules**

Voyd uses a file-and-folder based module system similar to modern Rust.
A module is defined by a file, and submodules are defined inside a directory of the same name.

Voyd's module system aims to be predictable, easy to navigate, and friendly to tooling.

---

# **Defining Modules**

## **Module Layout**

A module named `math` can be defined in either of these equivalent ways:

### **1. Single-file module**

```
src/math.voyd
```

### **2. Multi-file module**

```
src/math.voyd      // root of the math module
src/math/
  add.voyd         // submodule math::add
  sub.voyd         // submodule math::sub
```

If a directory exists with the module name, every file inside that directory becomes a submodule.

Package root: `pkg.voyd` is the package entry that defines what is exported to other packages (via `pub use` / top-level `pub` declarations). Other modules are normal.
If `pkg.voyd` defines `pub fn main`, that function is the executable entry point; otherwise the package is a library.

---

# **Examples**

### **From a file**

```voyd
// src/internal.voyd
api fn hey()
  "hey"
```

```voyd
// src/main.voyd
use internal

internal::hey()
```

### **From a directory**

```
src/
  internal.voyd
  internal/
    hey.voyd
```

`internal/hey.voyd` defines the module `internal::hey` automatically.
No manual export boilerplate is required unless you want to re-export selectively.

```voyd
// src/internal.voyd
pub mod hey  // export the submodule
```

```voyd
// src/main.voyd
use internal::hey

hey::hey()
```

---

# **Inline Modules (the `mod` block)**

For small cases you may define modules directly inside a file:

```voyd
// src/main.voyd

mod internal
  api fn hey()
    "hey"

internal::hey()
```

Inline modules behave exactly like file-based modules.

---

# **Module Imports (`use`)**

The `use` statement brings modules or items into scope.

```voyd
use my_module

my_module::hello()
```

## **Selective imports**

```voyd
use my_module::hello
hello()
```

## **Group imports**

```voyd
use my_module::{ self, a, b }
```

## **Renaming**

```voyd
use my_module::hello as hi
```

## **Importing all exports**

```voyd
use my_module::all
```

## **Standard library and package imports**

```voyd
use std::log
use pkg::json
```

The standard library's public API is defined in `std/pkg.voyd`, but consumers
import it directly through `std::...` paths. `std::pkg` is not a user-facing
module path.

## **Importing relative to the source root**

```voyd
use src::logger
```

---

# **Module Path Rules**

Module paths behave like directory paths:

```
a::b::c
```

…represents the file `a/b/c.voyd` or directory `a/b/c/`.

### **Examples**

```
src/utils/hello/world.voyd   // You are here
src/utils/goodbye/jupiter.voyd
```

To import `jupiter`:

```voyd
use utils::goodbye::jupiter
```

---

# **Relative Imports**

If a `use` path does not start with `src`, `std`, or `pkg`, it is resolved
relative to the current module's directory.

Example layout:

```
src/utils/foo.voyd
src/utils/bar.voyd
```

```voyd
// src/utils/bar.voyd
use foo          // imports module src::utils::foo
use foo::all     // imports pub exports from src::utils::foo

foo::id()
```

Use `src::...` (or `pkg::...`) to import from the package root explicitly.
If there is any ambiguity, prefer an explicit namespace.

---

# **Visibility**

Voyd is safe-by-default.

| Marker     | Meaning                                          |
| ---------- | ------------------------------------------------ |
| **(none)** | Private to the defining module                   |
| **pub**    | Package-visible (any module in the same package) |

Public API (visible to other packages) comes only from `pkg.voyd` exports.

Members (the methods and fields of a type) have their own markers for added
safety

| Marker     | Meaning                                                    |
| ---------- | ---------------------------------------------------------- |
| **pri**    | Private to the type, only accessible from internal methods |
| **(none)** | Package visible when parent type is `pub`                  |
| **api**    | Public API visible                                         |

Note that even if a type is exported from `pkg.voyd` only members marked with
`api` will be visible to other packages.

### **Examples (top-level)**

```voyd
pub fn package_func()    // Available to any module in the same package
fn private_func()        // Only inside this file/module
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

To expose `Vec` to other export them from `pkg.voyd`:

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
---

# **Exporting From a Module**

Exports are controlled with `pub mod` and `pub use`.

### **Export a submodule**

```voyd
pub mod math            // exposes math::*
```

### **Export a specific item from a submodule**

```voyd
pub mod math::{ add }   // exposes math::add
```

### **Rename on export**

```voyd
pub mod math::{ mul as multiply }
```

### **Export all public items from a module**

```voyd
pub mod strings::all
```

### **Re-export using `use`**

```voyd
pub use strings::all
```

---

# **Export Examples**

```voyd
// src/lib.voyd

// Re-export all submodules of math
pub mod math::all

// Export only the sub module
pub mod sub

// Export mul as multiply
pub mod mul::{ self as multiply }

// Export div::div as divide
pub mod div::{ div as divide }

// Export and bring into this module’s scope
pub use strings::all
```

---

# **More Complex Example**

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
pub fn log_vec()
  log vec::Vec {}  // valid, vec is sibling and exported

use vec::{ Vec, mul }

fn work()
  mul(Vec {}, Vec {})
```

### **server/users/get_user.voyd**

```voyd
use server::fetch       // valid: server is ancestor & fetch is exported
use api::start_api      // error: api is sibling-of-ancestor, not ancestor

pub fn get()
  fetch()
```

### **server/users/add_user.voyd**

```voyd
pub fn add()
  server::fetch()       // valid: fetch is exported
```

### **server/api.voyd**

```voyd
use users::get_user     // valid: sibling module users exports get_user
use users::add_user     // error: add_user is not exported

fn start_api()
  ...
```

---

# **Module Keywords**

### **Module commands**

* `pub` — Export with full visibility
* `api` — Export within package only
* `mod` — Define an inline module
* `use` — Bring modules into scope

### **Path keywords**

* `all` — Import/export all public items from a module
* `self` — Refer to the module itself inside group imports
* `std` — Standard library
* `src` — Source root
* `pkg` — Installed packages

### **Reserved**

* Modules cannot use keywords as names.
