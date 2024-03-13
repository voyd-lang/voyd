## Modules

```void
use src::lib::* // Import everything from src/lib
use src::lib as my-lib // Import everything as my-lib
use src::lib::{ my-util-function } // Import my-util-function from src/lib
use src::lib::{ func-a sub-module: { func-b } } // Import func-a from src/lib and func-b from the submodule in src/lib
use super::helpers::{ func-a as func-c } // Import func-a as func-c from the parent module of helpers
// If the path points to a folder, an index.void is assumed
use src::folder::{ b } // Resolves to src/folder/index.void
use package::my_package::{ pack-func } // Import pack-func from the installed package called my_package.

mod my-module // Create a new module within the current module
    fn my-func() // Define a function within the module
        print "Hello from my-module"
```
