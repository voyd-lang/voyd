# Todo List

- Unsafe macros (As add unsafe macro and check safety macros that do a form of "unsafe" checking
  i.e. rust)
- Fix bug in modules where I can't run syntax macros directly on files within std
- Write up a layout spec defining exactly how parenthetical elision works
- Hygienic macros
- Consider making $() a block, rather than assuming a function call
- Develop and apply strict naming conventions for all APIs
- Develop best practices
- `def` macro like https://docs.racket-lang.org/guide/syntax-overview.html#%28part._.Definitions%29
- Adopt some conventions from https://docs.racket-lang.org/style/Textual_Matters.html like `!` and
  `?` conventions
- Flags for outputting AST and WAT
- Use tabstops (the thing that handles tab based comment alignment etc)
- Support struct field assignment via `=` operator
- Check mutability of struct before allowing modification (&mut semantics?)
- replace `quote splice-block` with `quote-splice` or something similar.
- Rewrite reference manual.
- Consider using the struct syntax to define named arguments. See
  `archived-reference/functions.md#NamedArguments` for inspiration.
- Scoping. For macro expansion and compile time. Probably need a semantic analysis phase in general.
  Without this type-ids for structs are broken
- De-allocate allocated memory inside of blocks.
- Cleanup pass
  - Make typing of variables, functions and parameters much more clear and consistent, both
    at the `define-function` header level and body level.
  - Make spread of define-function, fn and lambda more consistent. They use a mix of either the last
    is a single expr, or a bunch of expressions
- Reference Types (Boxes? / Mutable Borrows? / GC? / Ownership?)
- Test sub tuple init and assignment
- Copy CDTs on assignment
- Anonymous struct literals
- Erlang like atoms for to facilitate optionals and other union data types that may not need associated data.
- Optional parameters and default parameter values.
- Pre type system phase IR spec.
- Make dot `.` a macro and pull the logic from infix
- Reset getAllFnParams etc each time a function is used in syntax for macro phase. Right now parameters and variables get re-registered each time the function is executed.
- Smarter lets and vars. Should detect when they are in or out of a function and create a global when out of one automatically. Should also remove m-let as a result.
- Fix bug where using comments in match statements at macro expansion time can change behavior see example 1
- Simplify `setFn` and `setVar`. Type info should be attached to identifier, so passing it is redundant
- Create a Fn expr that extends list and handles accessing of parameters, return type, body, etc.
- Create a Call expr that extends lists and handles references to the function identifier etc.
- Figure out how to avoid having to double quote macros
- Major cleanup pass. There is much room for easy refactors
- Fix object field assignment
- Old variable registration from type system can interfere with code gen index lookup. For example,
  there was a bug in the code-gen layer that re-registered an identifier at the wrong level. The
  older registration was left untouched (with an out-of-date index). So when the identifier was
  later retrieved, the wrong index was fetched. This is mostly a safety issue. Need to figure out
  a better way to handle index updates, rather than relying on the code gen to re-register a
  variable altogether.

# Examples

Example 1

```
let write-fn = field-type.match
	"i32" `(store-i32)
	"i64" `(store-i64)
	"f32" `(store-f32)
	"f64" `(store-f64)
	`(store-i32) // Bleep bloop blop
```
