- Unsafe macros (As add unsafe macro and check safety macros that do a form of "unsafe" checking
  i.e. rust)
- Fix bug in modules where I can't run syntax macros directly on files within std
- Write up a layout spec defining exactly how parenthetical elision works
- Hygienic macros
- Consider making $() a block, rather than assuming a function call
- Investigate why commas can't separate arguments but can separate array values
- Develop and apply strict naming conventions for all APIs
- Develop best practices
- reduce aggressiveness of macro-expand calls. We do it more than we need to. Probably.
- Write a formal spec for Dream IR (Post expansion expressions)
- Support block level scoping
- `def` macro like https://docs.racket-lang.org/guide/syntax-overview.html#%28part._.Definitions%29
- Adopt some conventions from https://docs.racket-lang.org/style/Textual_Matters.html like `!` and
  `?` conventions
- Make spread of define-function, fn and lambda more consistent. They use a mix of either the last
  is a single expr, or a bunch of expressions
