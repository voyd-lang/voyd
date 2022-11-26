# Modules

## Importing Modules With Use

### Syntax

```dream
use src/lib * ; Import everything from src/lib
use src/lib as my-lib ; Import everything as my-lib
use src/lib { my-util-function } ; Import my-util-function from src/lib
use src/lib { func-a sub-module: { func-b } } ; Import func-a from src/lib and func-b from the submodule in src/lib
use super/helpers { func-a: func-c } ; Import func-a as func-c from ../helpers
use @package { pack-func } ; Import pack-func from the installed package called package
```
