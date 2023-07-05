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
