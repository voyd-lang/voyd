---
order: 200
---

# Types Overview

The Voyd type system is structural at its core and supports nominal types
through the use of objects and traits.

- [Types Overview](#types-overview)
- [Defining Types](#defining-types)
- [Data Types](#data-types)
  - [Primitive Data Types](#primitive-data-types)
  - [Objects](#objects)

A type comes in a few categories:
- `Data` - The most basic types that store bits of information
- `Function` - Types that represent functions
- `Trait` - Types that represent a collection of function types that can be
  implemented by a type
- `Effect` - Types that represent side effects a function can have

All but effect types in Voyd are first class, that is they can be passed as
arguments to functions, returned from functions, and assigned to variables.

# Defining Types

Types are typically defined using the `type` keyword followed by the type name,
an equal sign, and a type expression representing how the type is satisfied.

The most basic type definition is an alias for another type:

```voyd
type Name = String
```

# Data Types

Data types store bits of information that can be operated on. All data types
are either value types or reference types.

Value types are copied when passed to a function or assigned to a variable. They
are stored on the stack.

Reference types are heap allocated, passed by reference. This means that two
variables can point to the same reference type. There are rules for this shared
ownership which are detailed in the memory chapter.

## Primitive Data Types

Primitive data types are the most basic data types in Voyd. They are value types
that act as the building blocks for more complex data types.

They include:
- `i32` - 32 bit signed integer
- `i64` - 64 bit signed integer
- `u32` - 32 bit unsigned integer
- `u64` - 64 bit unsigned integer
- `f32` - 32 bit floating point number
- `f64` - 64 bit floating point number
- `v128` - 128 bit SIMD vector
- `bool` - Boolean (technically an i32 considered to be false when 0 and true
  when non-zero)
- `voyd` - The absence of a value

TODO: Add more information about each of these types.

## Objects

Objects are extensible data types that can be used to represent complex user
defined data structures. See the [Objects](./objects.md) chapter for more details.
