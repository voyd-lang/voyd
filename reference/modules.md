# Modules

Modules provide an easy way to organize dream source code in a hierarchical manor.

Modules can be created using module blocks, files, and folders with an index.dm file.

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

File modules can only be imported by other sibling modules in the same folder. They
can be exported for use using an index.dm file, more on that in the Folder Modules section.

```dream
// src/math.dm
pub fn add(a: Int, b: Int) = a + b
pub fn sub(a: Int, b: Int) = a - b
```

```dream
src/main.dm
use [add, sub] from "math"

fn main() = 3.add(4).sub(1).print()
```

# Folder Modules

Folder level modules can be used to expose internal modules to other folders.

Folder modules are accessed using the name of the folder. They are defined using
an index.dm file from inside the folder


```dream
// src/math/ops.dm

pub fn add(a: Int, b: Int) = a + b
pub fn sub(a: Int, b: Int) = a - b
pub fn mul(a: Int, b: Int) = a * b
```

```dream
// src/math/min_max.dm

pub fn min(a: Int, b: Int) = if a < b { a } else { b }
pub fn max(a: Int, b: Int) = if a > b { a } else { b }
```

```dream
// src/math/constants.dm

pub let PI = 3.14159
```


```
// src/math/index.dm

// Export the entire ops module
pub use ops

// Export only the min function from min_max
pub use [min] from min_max

// Export everything in the constants module as part of the math namespace
pub use * from constants.dm
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
```

Basic import:
```
// src/main.dm

use helpers

pub fn main() = {
    helpers.foo()
    helpers.bar()
}
```

Merged namespace import:
```
// src/main.dm

use * from helpers

pub fn main() = {
    foo()
    bar()
}
```

Selective import:
```
use [foo] from helpers

pub fn main() = {
    foo()

    // Error, no function bar in scope
    bar()
}
```
