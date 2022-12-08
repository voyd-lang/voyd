# Modules

## Root Module

Type: Root

Syntax:

```lisp
(root $module-id:String $modules:Module*)
```

## Standard Module

Type: Module

Syntax:

```lisp
(module $module-id:String
  (imports ($import-module-id "***")*)
  (exports $exports:Export*)
  (block $body*))
```

Example export `["export", "'<'", ["parameters", ["left", "i32"], ["right", "i32"]]]`

## Use (Module Imports)

Dream Syntax:

```dream
use src/lib *** // Import everything from src/lib
use src/lib as my-lib // Import everything as my-lib
use src/lib { my-util-function } // Import my-util-function from src/lib
use src/lib { func-a sub-module: { func-b } } // Import func-a from src/lib and func-b from the submodule in src/lib
use super/helpers { func-a: func-c } // Import func-a as func-c from ../helpers
use dir/helpers { a } // import a from ./helpers
// If the path points to a folder, an index.dm is assumed
use src/folder { b } // Resolves to src/folder/index.dm
use package { pack-func } // Import pack-func from the installed package called package. Note folders take precedent over installed packages
```
