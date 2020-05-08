# DIR

Dir's responsibility is to convert the AST into a more compiler friendly IR. It's job is to desugar
syntax, expand macros, perform name resolution, generic expansion and error checking.
Dir is analogous to [rusts lowering process](https://rustc-dev-guide.rust-lang.org/lowering.html).
