# Today

- Fix macro interpreter
- Add unit test for resolveFileModules
- Cleanup parenthetical elision code, make it more functional if possible


# High Level

- Improve function overloading support so they can be treated as a normal entity.
	- Idea: Add new entity, FnCollection, which is a collection of functions with the same name in the same scope.
- Update generics syntax to `my_fn[T]` instead of `my_fn::<T>`
	- We should be able to do this and keep array syntax as `[1, 2, 3]`. Since we don't support array subscript syntax (`my_array[0]`) anyway.
- Support whitespace curly block syntax
- Audit code base for side effects, style, and functional purity
- Support whitespace curly block syntax inside of strings / string interpolation
- Add jest tests for parsing phase
- Repair macro syntax macro
- Repair type system
- Add jest tests for syntax phase
- Add back support for object syntax
- Add GC
- Add jest tests for code gen phase (assembly phase?)
- Describe / Add [Call By Name semantics](https://en.wikipedia.org/wiki/Evaluation_strategy#Call_by_name)
	- We may want to use swift's @autoclosure feature for this
	- https://contributors.scala-lang.org/t/make-by-name-parameters-just-sugar-syntax-rather-than-actual-types/5228/21
- Better separate the language reference from the specification
	- The specification should be a formal description of the language, and use ebnf to describe the syntax
	- The reference should be a more informal description of the language, targeting users.
- Support safe mutation https://dl.acm.org/doi/pdf/10.1145/3471874.3472988

Data types:
- Decide on if self is implicit or explicit
- Should obj be renamed to class
- Decide on wether an obj can have methods as part of their initial definition
- How do we define method requirements in a structural type.
