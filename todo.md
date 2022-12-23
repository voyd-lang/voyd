- Unsafe macros (As add unsafe macro and check safety macros that do a form of "unsafe" checking
  i.e. rust)
- Fix bug in modules where I can't run syntax macros directly on files within std
- Write up a layout spec defining exactly how parenthetical elision works
- Hygienic macros
- Consider making $() a block, rather than assuming a function call
- Investigate why commas can't separate arguments but can separate array values
- Develop and apply strict naming conventions for all APIs
- Develop best practices
- Write a formal spec for Dream IR (Post expansion expressions)
- Support block level scoping
- `def` macro like https://docs.racket-lang.org/guide/syntax-overview.html#%28part._.Definitions%29
- Adopt some conventions from https://docs.racket-lang.org/style/Textual_Matters.html like `!` and
  `?` conventions
- Make spread of define-function, fn and lambda more consistent. They use a mix of either the last
  is a single expr, or a bunch of expressions
- Massive cleanup pass (spec + wasm-code-gen)
- Flags for outputting AST and WAT
- Use tabstops (the thing that handles tab based comment alignment etc)
- Support struct field assignment via `=` operator
- Check mutability of struct before allowing modification (&mut semantics?)
- replace `quote splice-block` with `quote-splice` or something similar.
- Improve macro expansion algorithm so macros like `var` and `let` don't need to call
  `macro-expand`. Outside of `pub`, I don't believe any macro should need to call that function
  unless they need to extract info post expansion like `pub` does.
  https://stackoverflow.com/questions/72865649/how-does-macroexpansion-actually-work-in-lisp
- Rewrite reference. Also move the files that are more reference oriented from spec to reference.
  (i.e. not the ll-ir)
- Consider using the struct syntax to define named arguments. See
  `archived-reference/functions.md#NamedArguments` for inspiration.
- Scoping. For macro expansion and compile time. Probably need a semantic in general. Without this
  type-ids for structs are broken
