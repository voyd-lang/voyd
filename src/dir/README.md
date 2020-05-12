# DIR

Dir's responsibility is to convert the AST into a more compiler friendly IR. It's job is to desugar
syntax, expand macros, perform name resolution, and expand generics. It's output is designed to
be easier to error check and then compile to WASM then the AST.
Dir is analogous to [rusts lowering process](https://rustc-dev-guide.rust-lang.org/lowering.html).
