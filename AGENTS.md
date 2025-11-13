# Voyd Programming Language

This repository contains the implementation of the voyd programming language.
voyd is a level between rust and typescript in terms of abstraction. It
compiles to webassembly.

Any form of git network commands are forbidden. Including `git push` & `git pull`

# Debugging

A cli is available after `npm link`

Helpful commands:
- `vt --emit-parser-ast <path-to-voyd-file>`
- `vt --run <path-to-voyd-file>` // runs the pub fn main of the file
- `vt --emit-wasm-text --opt <path-to-voyd-file>` // Careful, this can be large

# Testing

- `npm test` (runs vitest suite)
- `npx vitest <path-to-test>`

You should generally add unit tests (especially e2e ones like those in
`src/__tests__) when adding new features or fixing bugs.

# Style Guide

- Prefer functional pipelines for general logic; use classes when encapsulating shared state or factory-style behavior
- Keep functions small
- Prefer early returns to else ifs
- Use `const` whenever possible
- Use ternary conditionals for conditional variable init
- Files should be ordered by importance. The main export of a file at the top.
