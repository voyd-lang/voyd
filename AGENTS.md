# Voyd Programming Language

This repository contains the implementation of the voyd programming language.
voyd is a level between rust and typescript in terms of abstraction. It
compiles to webassembly.

# Directory Index

- `apps/cli`: `voyd` / `vt` command line entrypoints.
- `apps/smoke`: End-to-end smoke tests (prefer adding public API tests here).
- `apps/site`: `voyd.dev` docs/playground site.
- `apps/vscode`: VSCode extension and language client wiring.
- `packages/compiler`: Parser, semantics, and Wasm codegen pipeline.
- `packages/language-server`: LSP server built on compiler + std.
- `packages/sdk`: Public Node/browser/deno APIs for compile/run/test flows.
- `packages/lib`: Shared runtime/tooling utilities (CLI helpers, binaryen helpers, VSX DOM client).
- `packages/js-host`: JS host runtime used for executing compiled modules.
- `packages/std`: Standard library source bundle (Voyd source).
- `packages/reference`: Language reference source/build scripts.
- `docs/architecture`: Design constraints and cross-module contracts.

# Architecture Overview

- Monorepo layout: product surfaces live in `apps/*`, reusable language/runtime components live in `packages/*`.
- Compilation flow (authoritative path): parser -> semantics (typing/binding/lowering) -> `ProgramCodegenView` -> Wasm codegen.
- Boundary rule: `packages/compiler/src/semantics/codegen-view` is the contract; codegen should consume this view, not typing internals.
- Runtime split: compiler emits Wasm, while `@voyd/js-host` + `@voyd/lib` provide JS-side execution and interop helpers.
- Public integration point: `@voyd/sdk` composes compiler + host + std and is the preferred API for tests and external tooling.
- Developer tooling stack: CLI (`apps/cli`), language server (`packages/language-server`), and VSCode extension (`apps/vscode`) all build on shared packages.

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
- `npm run typecheck`.
- `npx vitest <path-to-test>`

You should generally add unit tests (especially e2e ones)

E2E Unit tests should go in apps/smoke (unless strictly scoped to the compiler). Always prefer the public API

# TS Style Guide

- Keep functions small
- Prefer early returns to else ifs
- Use `const` whenever possible
- Use ternary conditionals for conditional variable init
- Prefer functional control flow (`map`, `filter`, etc) to imperative loop constructs.
- Files should be ordered by importance. The main export of a file at the top.
- Use a single parameter object for functions containing more than three params to name the parameters on call.
- Avoid reaching across module boundaries.

## Voyd Style Guide

Guide for writing voyd code and APIs. Voyd APIs should share a similar
spirit to [Swift API Design Guidelines](https://www.swift.org/documentation/api-design-guidelines/)

- Snake case for functions, variables, and effect ops. UpperCamelCase for types and effects
- Treat labels as required when a function has more than two non-`self` parameters, unless there is a clear readability reason not to.
- For two non-`self` parameters, prefer labels when they improve clarity or prevent ambiguity.
- Make use of function / method overloading when it makes semantic sense.
- Prefer positional parameters when a label does not add clarity (for example `push(value: x)` should be `push(x)`).
- Avoid labels that only repeat the function name or obvious role (`contains_key({ key })` should prefer `contains(key)`).
- Use labels to distinguish overload families when argument types overlap (`contains(key: ...)`, `contains(value: ...)`, `contains(where: ...)`).
- Prefer semantic base function names over type-encoded names. Use labels to describe input role/source instead of suffixes like `_bytes` when practical (for example `ascii_string_from(bytes: source)`).
- Any public/api function that accepts `StringSlice` should also provide a `String` overload with equivalent behavior. Implement one overload as a thin forwarder to avoid duplicated logic.
- Use stable effect ids with module-path naming: `@effect(id: "<package>::<module_path>::<EffectName>")` (for example `std::fs::Fs`), and keep IDs aligned with real module paths.
