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
There is **no `mod.voyd` or `index.voyd`** special file.

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

# **Visibility**

Voyd has three visibility levels:

| Keyword    | Meaning                                                           |
| ---------- | ----------------------------------------------------------------- |
| **(none)** | Private to the defining module                                    |
| **api**    | Public inside the containing package, but not exported outside it |
| **pub**    | Fully public and exportable everywhere                            |

### **Examples**

```voyd
pub fn public_func()     // Available to any module or package
api fn package_func()    // Only inside this package
fn private_func()        // Only inside this file/module
```

For objects:

```voyd
pub obj Vec {
  api x: i32   // visible within the package
  y: i32       // private
  #z: i32      // explicitly private
}
```

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
