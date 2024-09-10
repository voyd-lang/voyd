# Modules

## Defining a module

Modules can be defined using the `mod` keyword, a file, or a directory

**With the mod keyword:**

```void
// src/main.void

mod internal
  pub fn hey()
    "hey"

internal::hey()
```

**From a file:**

```void
// src/internal.void
pub fn hey()
  "hey"
```

```void
// src/main.void

// Bring internal module into scope with a use import
use internal

internal::hey()
```

**From a directory:**

```void
// src/internal/hey.void

pub fn hey()
  "hey"
```

A mod.void file acts as the index of the module and must be defined for each directory

```void
// src/internal/mod.void

// export the hey function from the hey module index (mod) file
pub mod hey::hey

// Alternatively, you can define a void file that shares a name
// with the directory.
// src/internal.void
pub mod hey::hey
```

```void
// src/main.void

use src::internal

internal::hey()
```

## Module Imports - Use Statements

The `use` statement brings modules into scope.

```void
// src/some/deeply/nested/module.void <- the current file

// Import the the sibling module, "internal", from
// src/some/deeply/nested/internal.void
use internal

internal::hey()

// Bring the `hey` function directly into scope
use internal::hey

hey()

// Bring hello and world functions into scope in one statement,
// you can also use the self keyword to bring the internal module
// into scope in the same statement as well
use internal::{ self, hello, world }

// Import the hello function as goodbye
use internal::{ hello as goodbye }

// Import the internal module as a_diff_name
use internal::{ self as a_diff_name }

// Import all exports from internal
use internal::all

// Import the module named logger from the source code root at src/logger.void
use src::logger

// Import log from the standard library
use std::log

// src/some/deeply/nested/module.void <- (still the current file)
// Import cousin module from src/some/dee
```

### Module Keywords

Module commands
- `pub` Export
- `mod` Define a module
- `use` Bring a module into scope

Path keywords
- `dir` import an item from the parent module
- `self` refers to the module itself, used to bring the module into scope as well as some of its children in the same call
- `std` The void standard library
- `src` The source root
- `pkg` Module containing installed packages

Note: A module cannot have a keyword for a name

# Exporting from a module


```void
// src/mod.void

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

Note: Sibling modules are allowed to import each other, event when not exported
by the parent module.
