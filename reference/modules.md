# Modules

## Defining a module

Modules can be defined using the `mod` keyword, a file, or a directory

**With the mod keyword:**

```
// src/main.void

mod internal
  pub fn hey()
    "hey"

internal::hey()
```

**From a file:**

```
// src/internal.void
pub fn hey()
  "hey"
```

```
// src/main.void

// Bring internal module into scope with a use import
use super::internal

internal::hey()
```

**From a directory:**

```
// src/internal/hey.void

pub fn hey()
  "hey"
```

A mod.void file acts as the index of the module and must be defined for each directory

```
// src/internal/mod.void

// export the hey function from the hey module
pub use hey::hey
```

```
// src/main.void

use src::internal

internal::hey()
```

## Keywords

## Module Imports - Use Statements

The `use` statement brings modules into scope.

```
// src/some/deeply/nested/module.void

// Import the the sibling module, "internal", from src/some/deeply/nested/internal.void
use super::internal

internal::hey()

// Bring the hey function directly into scope
use super::internal::hey

hey()

// Bring hello and world functions into scope in one statement,
// you can also use the self keyword to bring the internal module
// into scope in the same statement as well
use super::internal::{ self, hello, world }

// Import the hello function as goodbye
use super::internal::{ hello as goodbye }

// Import the internal module as a_diff_name
use super::internal as a_diff_name

// Import all exports from internal
use super::internal::*

// Import the module named logger from the source code root src/logger.void
use src::logger

// Import log from the standard library
use std::log
```

### Use Keywords

- `super` import an item from the parent module
- `self` refers to the module itself, used to bring the module into scope as well as some of its children in the same call
- `std` The void standard library
- `void` Alias for the void standard library
- `src` The source root

Note: A module cannot have a keyword for a name

# Exporting from a module


```void
// src/mod.void

// Export everything from the math file module
pub use math::*

// Export only the sub function from the sub file module
pub use sub

// Export the mul module
pub use mul

// Export the mul module as multiply
pub use mul as multiply

// Export the div function from the div module as divide
pub use div::{ div as divide }
```

Note: Sibling modules are allowed to import each other, event when not exported
by the parent module.
