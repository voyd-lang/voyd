# Voyd Programming Language

This repository contains the implementation of the voyd programming language.
voyd is a level between rust and typescript in terms of abstraction. It
compiles to webassembly.

# Debugging

A command line tool is available installable with `npm link`

Helpful commands:
- `npx vitest run <path-to-test-files>` Prefer running specific tests until feature implemented, then `npx vitest` to run the full suite to verify at the end.
- `vt --emit-parser-ast <path-to-voyd-file>`
- `vt --run <path-to-voyd-file>` // runs the pub fn main of the file
- `vt --emit-wasm-text --opt <path-to-voyd-file>` // Careful, this can be large

- VOYD_DEBUG_CLONE: enable clone profiling for type clones. Prints a compact summary on process exit.
  - Example: `VOYD_DEBUG_CLONE=1 npx vitest run src/__tests__/map-init-infer.e2e.test.ts`
- VOYD_DEBUG_INFER: enable inference trace logs for type-arg unification.
  - Example: `VOYD_DEBUG_INFER=1 npx vitest run src/__tests__/map-init-infer.e2e.test.ts`


# Testing

This repo uses vitest for testing. You can run the full test
suite with `npm test`. Prefer `vitest run` to `vitest`.

You should generally add unit tests (especially e2e ones like those in
`src/__tests__) when adding new features or fixing bugs.

Note: If tests fail and you are out of time, commit your results anyway and
inform the user of the test failure. Its better to be able to try and debug
the code than to have the work thrown away.

# Style Guide

- Use flat code with early returns
- Break down large functions into smaller ones
- Use functional style programming
- Prefer ternary conditionals to if statements for initializing vars
