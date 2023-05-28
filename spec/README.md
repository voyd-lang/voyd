# Void Language Spec

Because Void is still under heavy pre-alpha development. This specification only describes high level and reasonably stable behaviors of the language. While in this stage of development, the spec mostly
serves as a reference to aid contributing to the development of the language. It is not detailed
enough to serve as a basis for standardization.

**Audience**

This spec is primary as a reference for Void Language developers. Though it may be useful
for users of the language as well, especially those writing libraries and working with macros.

**Structure**

This specification is broken down into two main parts:

- [The Surface Language Specification](./surface.md) (What users write and know as the Void language)
- [The Core Language Specification](./core.md) (What macros expand into, resembles the structure the compiler works with directly)
