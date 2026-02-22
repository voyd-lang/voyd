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

If you find additional information that can save you time later add it here.

Additional notes:
- Companion tests (`*.test.voyd`) are merged into their companion module when `includeTests` is enabled. In companion tests, avoid importing the same module via `std::...`; reference companion symbols directly or module resolution can fail with `BD0001`.
- For ASCII encoder outputs in stdlib modules, prefer `new_string(bytes.to_fixed_array())` over `from_utf8(bytes: ...)` to avoid hangs in downstream string operations in current runtime paths.
- Symbol resolution now has explicit kind-aware APIs in `packages/compiler/src/semantics/binder/symbol-table.ts` (`resolveByKinds`, `resolveAllByKinds`, `resolveWhere`, `resolveAllWhere`).
- Same-name effect ops and wrapper functions are supported. Value-position lookup excludes `effect-op` symbols, while handler-head lookup resolves `effect-op` symbols explicitly.
- Do not reintroduce wrapper renaming/module-split workarounds for effect-op name collisions.
- Host boundary DTO compatibility is enforced at compile time for effect payloads. Allowed payload categories are: `bool`, `i32`, `i64`, `f32`, `f64`, `void`, or types annotated with `@serializer("msgpack", ...)`.
- Unsupported host-boundary payload shapes should fail with clear `CG0001` diagnostics (not runtime traps). Keep API-to-DTO shim conversions at effect boundaries.
- Enable compile instrumentation with `VOYD_COMPILER_PERF=1` to print phase timings (`loadModuleGraph`, `analyzeModules`, `emitProgram`, `total`) and hotspot counters as one `[voyd:compiler:perf]` JSON line per compile.
- Current `@voyd/js-host` event loop is cooperative and serial per run (`runEffectLoop`): handlers are awaited one-at-a-time, only the returned continuation call is applied, and there is no public cancellation API yet.

# Testing

- `npm test` (runs vitest suite). Always confirm this passes before finishing.
- `npm run typecheck`.
- `npx vitest <path-to-test>`

You should generally add unit tests (especially e2e ones)

# TS Style Guide

- Keep functions small
- Prefer early returns to else ifs
- Use `const` whenever possible
- Use ternary conditionals for conditional variable init
- Prefer functional control flow (`map`, `filter`, etc) to imperative loop constructs.
- Files should be ordered by importance. The main export of a file at the top.
- Use a single parameter object for functions containing more than three params to name the parameters on call.

## Voyd Style Guide

Guide for writing voyd code and APIs. Voyd APIs should share a similar
spirit to [Swift API Design Guidelines](https://www.swift.org/documentation/api-design-guidelines/)

- Snake case for functions, variables, and effect ops. UpperCamelCase for types and effects
- Always use labeled parameters when there are more than three parameters `fn foo({ a: i32, b: i32, c: i32 })` `foo(a: 1, b: 2, c: 3)`
- Make use of function / method overloading when it makes semantic sense.
