# Modules

Void uses a module system that borrows heavily from Rust's module semantics.

## Defining Modules

In voyd modules are defined using files and folders, folders being
the parent module of their files.

**From a file:**

```voyd
// src/internal.voyd
pub fn hey()
  "hey"
```

```voyd
// src/main.voyd

// Bring internal module into scope with a use import
use internal

internal::hey()
```

**From a directory:**

```voyd
// cd src/internal/hey.voyd

pub fn hey()
  "hey"

// cd src/internal/mod.voyd
pub mod hey::hey // export the hey function from the hey module index (mod) file

// Alternatively, you can define a voyd file that shares a name
// with the directory.

// cd src/internal.voyd
pub mod hey::hey

// cd src/main.voyd
use src::internal

internal::hey()
```

Modules can also be defined within a file using the `mod` keyword.

**With the mod keyword:**

```voyd
// src/main.voyd

mod internal
  pub fn hey()
    "hey"

internal::hey()
```

## Module Imports - Use Statements

The `use` is used to bring other modules and their children into scope.

```voyd
use my_module

my_module::hey()

// Bring the `hey` function directly into scope
use my_module::hey

hey()

// Bring hello and world functions into scope in one statement,
// you can also use the self keyword to bring the my_module module
// into scope in the same statement as well
use my_module::{ self, hello, world }

// Import the hello function as goodbye
use my_module::{ hello as goodbye }

// Import the my_module module as a_diff_name
use my_module::{ self as a_diff_name }

// Import all exports from my_module
use my_module::all

// Import the module named logger from the source code root at src/logger.voyd
use src::logger

// Import log from the standard library
use std::log
```

Module paths work like directories, except `./` can be omitted, and instead
of `../`, the folder name is directly used

I.E.
```voyd
// src/utils/hello/world.voyd <- You are here
// src/utils/goodbye/jupiter.voyd <- We want to import this
use utils::goodbye::jupiter
```


Here are more examples of valid and invalid imports given a module hierarchy
```voyd
mod src
  mod utils
    mod vec
      pub obj Vec {}

      pub fn mul(a: Vec, b: Vec) -> Vec

    pub mod logger
      pub fn log_vec()
        log vec::Vec {} // Valid, use Vec directly from sibling module

      use vec::{Vec, mul} // Valid, bring vec and mul directly into scope

      fn work()
        mul(Vec {}, Vec {})

  mod server
    pub fn fetch()

    pub mod users
      pub mod get_user
        use server::fetch // Valid, server is a direct ancestor and fetch is exported
        use api::start_api // ERROR, api is not a direct ancestor, path is server::api::server

        pub fn get()
          fetch()

      mod add_user
        pub fn add()
          server::fetch() // Valid, server is a direct ancestor and fetch is exported

    pub mod api
      use users::get_user // Valid, users is sibling, get_user submodule is exported by sibling
      use users::add_user // ERROR, add_user is not exported

      fn start_api()
        // etc
```

### Module Keywords

Module commands
- `pub` Export
- `mod` Define a module
- `use` Bring a module into scope

Path keywords:
- `all` Bring everything exported by the preceding module into scope
- `self` refers to the module itself, used to bring the module into scope as well as some of its children in the same call
- `std` The voyd standard library
- `src` The source root
- `pkg` Module containing installed packages

Note: A module cannot have a keyword for a name

# Exporting from a module


```voyd
// src/mod.voyd

// Export everything from the math file module
pub mod math::all

// Export only the sub function from the sub file module
pub mod sub

// Export the mul module
pub mod mul

// Export the mul module as multiply
pub mod mul::{ self as multiply }

// Export the div function from the div module as divide
pub mod div::{ div as divide }

// Export everything from the strings module and bring it into the current scope
pub use strings::all
```
