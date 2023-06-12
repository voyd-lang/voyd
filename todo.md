# Todo List

- Add FnCall syntax object (should extend list)
- Add Assignment syntax object (should extend list)
- Add Macro syntax object (should extend list)
- Add MacroTimeLambda syntax object (should extend list)
- Add Block syntax object (should extend list)
- Add Root syntax object (should extend list)
- Add Module syntax object (should extend list)
- Separate Macro time variables from the lexical context
- Update internal source code to use new heap and stack based terms
  - Struct literal -> Object literal (class based, on the heap)
  - Tuple literal -> Tuples are the same as structs, but with out fields (on the stack)
  - (New) Struct literal -> A labeled tuple (on the stack)
- Are macros still hygienic? I think the list.push implementation prevents it since it sets child expressions parent to itself on clone.
- Error framework
  - Don't throw errors, collect them in an array
  - Continue processing until a detected error can prevent further processing
  - Display a list of all detected errors in the console before exiting.
- CLI Flags for outputting AST and WAT
- Smarter lets and vars. Should detect when they are in or out of a function and create a global when out of one automatically. Should also remove macro-let and macro-var as a result.
- Come up with an elegant language versioning strategy. Should be able to completely change how core language features work,
  libraries work, macros etc without breaking anything or forcing people to migrate. Should apply to libraries and applications
  written in the language as well.
- Use tabstops (the thing that handles tab based comment alignment etc)
- Consider making core language record or even JSON based, instead of pure S-Expressions.
- Figure out how to avoid having to double quote macros
  - I think I can do this just using $() interpolation. I def need to change that syntax to being a block rather than assuming its a function call.
- Write out ownership spec
- Consider making $() a block, rather than assuming a function call
- Macro runtime should also handle / allow function overloads (Zoom out - Macro runtime should behave as close to normal runtime as possible)
- Make `pub` as syntax macro
- Handle platform / runtime specific syntax macros
  - For now, their is only one - node/wasm
  - Codebase should be written so Void can easily be ported to other platforms or runtimes.
- Handle new define syntax (define now must include mutability)

OLD (NEEDS REVIEW)

- Unsafe effect handling (i.e. rust unsafe keyword)
- Develop and apply strict naming conventions for all APIs
- Check mutability of struct before allowing modification (&mut semantics?)
- De-allocate allocated memory inside of blocks.
- Cleanup pass
  - Make typing of variables, functions and parameters much more clear and consistent, both
    at the `define-function` header level and body level.
  - Make spread of define-function, fn and lambda more consistent. They use a mix of either the last
    is a single expr, or a bunch of expressions
- Test sub tuple init and assignment
- Copy CDTs on assignment
- Anonymous struct literals
- Optional parameters and default parameter values.
- Pre type system phase IR spec.
- Make dot `.` a macro and pull the logic from infix
