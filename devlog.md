# 8 July 2023

Expanding on the previous entry. There are multiple reasons I've made this change.

- I wanted the type system to be as simple as possible while still having the potential to match
  the power of typescript's type system (with the added bonus of run time types)
- Having both `class` and `struct` and potentially different runtime behavioral characteristics was
  not ideal.
- Structs are stupidly difficult to model in wasm in a way that is both performant and works with a gc system.
  - Linear memory cannot hold reference types
  - Structs could leverage multi-value, but they are a pain to work with in binaryen. We'd also have to be smart about how we pass them around.

# 4 July 2023

I'm changing the type system again. Heavily inspired by the paper, [Integrating Nominal and Structural Subtyping](https://www.cs.cmu.edu/~aldrich/papers/ecoop08.pdf).

Here are the changes:

- Remove struct and class
- Add object types
  - Objects are nominal
- `type` defines a literal (structural) type (essentially an alias)
- Literal types are structural, object types are nominal
- Most user types are assumed to be heap types now. Will need new /custom syntax do define stack types. Do not be afraid to make these more verbose and difficult to use, that is webassembly's fault, not yours.

The main benefit to this change is it is much simpler to understand, will likely be more fun write while also being more maintainable. Thee performance impact is worth the expressiveness. You can always use the more complex stack type system when you need the performance.

# 5 Dec 2022

**Changes:**

- Greedy operators (`;`, `=`, `=>`, etc) are much smarter now.

When next expression directly follows a greedy op, child expressions of the line are treated as
arguments of that expression. When the next expression is a child expression of the line, they become
part of a block
