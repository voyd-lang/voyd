# Voyd Programming Language

This repository contains the implementation of the voyd programming language.
voyd is a level between rust and typescript in terms of abstraction. It
compiles to webassembly.

# Guide

Always build with long term maintainability in mind. Avoid short term hacks.
If you encounter code or an architecture that could benefit from a refactor,
report on it and suggest direction in your final response.

Voyd has not yet been released. Breaking changes to public APIs are ok. Just
note the breaking changes if made.

# Debugging

A cli is available after `npm link`

Helpful commands:
- `vt --emit-parser-ast <path-to-voyd-file>`
- `vt --run <path-to-voyd-file>` // runs the pub fn main of the file
- `vt --emit-wasm-text --opt <path-to-voyd-file>` // Careful, this can be large

# Testing

- `npm test` (runs vitest suite). Always confirm this passes before finishing.
- `npm typecheck`.
- `npx vitest <path-to-test>`

You should generally add unit tests (especially e2e ones)

# Style Guide

- Keep functions small
- Prefer early returns to else ifs
- Use `const` whenever possible
- Use ternary conditionals for conditional variable init
- Prefer functional control flow (`map`, `filter`, etc) to imperative loop constructs.
- Files should be ordered by importance. The main export of a file at the top.
- Use a single parameter object for functions containing more than three params to name the parameters on call.
