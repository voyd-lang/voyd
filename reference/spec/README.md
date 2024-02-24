# Void Language Spec

This is the official specification for the Void Language. It is intended to be a
comprehensive but is currently a work in progress.

The eventual goal is to have a complete and accurate specification for the
language, including both the surface and core languages. And should allow for
alternative implementations to be written from it.

**Audience**

This spec is primary as a reference for Void Language developers. Though it may
be useful for users of the language as well, especially those writing libraries
and working with macros.

**Structure**

This specification is broken down into two main parts:

- [The Surface Language Specification](./surface.md) (What users write and know
  as the Void language)
- [The Core Language Specification](./core.md) (What macros expand into,
  resembles the structure the compiler works with directly)
