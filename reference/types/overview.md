# Types Overview

The Void type system is structural at its core and supports nominal types
through the use of objects and traits.

There are several categories of types in Void:
- [Data Types](#data-types)
- [Function Types](./function-types.md)
- [Traits](./traits.md)
- [Effects](./effects.md)

All but effect types in Void are first class, that is they can be passed as
arguments to functions, returned from functions, and assigned to variables.

# Data Types

Data types store bits of information that can be operated on. All data types
are either value types or reference types.

Value types are copied when passed to a function or assigned to a variable. They
are stored on the stack.

Reference types are heap allocated, passed by reference. This means that two
variables can point to the same reference type. There are rules for this shared
ownership which are detailed in the memory chapter.
