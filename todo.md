# Todo List

- Add Fn syntax object (should extend list)
- Add FnCall syntax object (should extend list)
- Add Assignment syntax object (should extend list)
- Add Macro syntax object (should extend list)
- Add MacroTimeLambda syntax object (should extend list)
- Add Block syntax object (should extend list)
- Add Root syntax object (should extend list)
- Add Module syntax object (should extend list)
- Add Variable syntax object
- Add Parameter syntax object
- Separate Macro time variables from the lexical context
- Rename current Identifier syntax object to Symbol and add a new Identifier syntax object
  - Add getDefinition method to Identifier object
- Compute Variable / Parameter index on get to ensure information is up to date.
- Phase out `value` and `is` from `Syntax`
- Update internal source code to use new heap and stack based terms
  - Struct literal -> Object literal (class based, on the heap)
  - Tuple literal -> Tuples are the same as structs, but with out fields (on the stack)
  - (New) Struct literal -> A labeled tuple (on the stack)

OLD (NEEDS REVIEW)

- Unsafe effect handling (i.e. rust unsafe keyword)
- Consider making $() a block, rather than assuming a function call
- Develop and apply strict naming conventions for all APIs
- Develop best practices
- CLI Flags for outputting AST and WAT
- Use tabstops (the thing that handles tab based comment alignment etc)
- Check mutability of struct before allowing modification (&mut semantics?)
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
- Figure out how to avoid having to double quote macros
- Check mutability of struct variable before field re-assignment (may need a borrow checker to do this right)
- Error framework
  - Don't throw errors, collect them in an array
  - Continue processing until a detected error can prevent further processing
  - Display a list of all detected errors in the console before exiting.
