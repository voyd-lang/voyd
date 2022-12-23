# Modules

Modules provide an easy way to organize dream source code in a hierarchical manor.

Modules can be created using module blocks, files, and folders with a mod.dm file.

Only items marked with pub can be accessed outside of their module.

# Module Blocks

Module

```
mod my_module {
    fn hello = print("hello")

    pub fn do_work = print("doing work")

    pub fn do_more_work = print("DOING EVEN MORE WORK")
}

my_module.do_work()
my_module.do_more_work()
my_module.hello() // ERROR! hello() is private.
```

# File Modules

In dream, every file is a module.

File modules can only be imported by other sibling modules in the same folder using their file name without the extension.


```dream
// src/math.dm

pub fn add(a: Int, b: Int) = a + b
pub fn sub(a: Int, b: Int) = a - b
```

```dream
// src/main.dm

use math

fn main() = math.add(2, math.sub(3, 4)).print()
```

# Folder Modules

Folder level modules can be used to organize source code in a hierarchy. Folder modules
take on the name of their folder and must contain a mod.dm file describing everything
the module makes public.

For example. A project could be organized using the following file structure:
- src
  - math
    - ops.dm
    - min_max.dm
    - constants.dm
    - mod.dm
  - main.dm


```dream
// src/math/ops.dm

pub fn add(a: Int, b: Int) = a + b
pub fn sub(a: Int, b: Int) = a - b
pub fn mul(a: Int, b: Int) = a * b
```

```dream
pub fn min(a: Int, b: Int) = if a < b { a } else { b }
pub fn max(a: Int, b: Int) = if a > b { a } else { b }

// src/math/min_max.dm
```

```dream
pub let PI = 3.14159

// src/math/constants.dm
```

To make the above modules accessible from outside the math folder, we re-export them
using the `pub use` syntax in `src/math/mod.dm`.
```
// src/math/mod.dm

// Export the entire ops module
pub use ops

// Export only the min function from min_max
pub use min_max.min

// If we wanted to instead export only the min and max functions, we could write the above like this
pub use min_max.[min, max]

// Export everything in the constants module as part of the math namespace
pub constants.*
```

```
// src/main.dm

use math

fn main() = {
    let four = math.ops.add(2, 2)
    let twoPi = math.PI * 2
    let six = math.min(6, 8)
}
```

# Importing

Given module:
```
// src/helpers.dm

pub fn foo() = {}
pub fn bar() = {}

pub mod more_helpers {
    pub fn baz() = {}
}
```

Basic module import:
```
// src/main.dm

use helpers

pub fn main() = {
    helpers.foo()
    helpers.bar()
    helpers.more_helpers.baz()
}
```

Wildcard import:
```
// src/main.dm

use helpers.*

pub fn main() = {
    foo()
    bar()
    more_helpers.baz()
}
```

Selective import:
```
use helpers.[foo, more_helpers.*]

pub fn main() = {
    foo()
    baz()

    // Error, no function bar in scope
    bar()
}
```
