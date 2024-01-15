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
- Consider using `fn name() effects -> returnType` instead of `fn name() -> (effects returnType)`
	- We do it the latter way because it's easier to parse, and it lets us treat `->` as a binary operator
	  But the former way is easier to read and understand.
	- The disadvantage of the former way is that we can't reasonably explicitly type lambda functions
	  (`() -> () => `) anymore. But if people need to do that they can just use an anonymous function instead `fn(param) ->`.
