# DIR

Dir's responsibility is to convert the AST into a more compiler friendly IR. It's job is to desugar
syntax, expand macros, perform name resolution, and expand generics. It's output is designed to
be easier to error check and then compile to WASM then the AST.
Dir is analogous to [rusts lowering process](https://rustc-dev-guide.rust-lang.org/lowering.html).

Dir Compilation Steps:
1. Scan the current scope of all signatures (struct, function, enum etc).
   1. Add the signature to a list
   2. If the signature corresponds to a sub scope, add the sub scope
2.
