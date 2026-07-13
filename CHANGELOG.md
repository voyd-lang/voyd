# Changelog

## Voyd v0.3.0 - Gaia BH1 (2026-07-12)

Voyd `0.3.0` is the full-stack web release. VX grew into a typed application
runtime, the new web package brings HTTP routing and server rendering to Voyd,
and external package adapters open a path to the JavaScript ecosystem without
making host details part of application code.

### Highlights

- Added the typed VX application architecture: `Program<Model, Msg>`,
  `program`, `next`, commands, subscriptions, async task commands, component
  state, browser event handling, DOM patching, hydration, and server rendering.
- Added `voyd bootstrap` templates for a client-side VX application and a
  full-stack server-rendered application.
- Added `std::http` client and server APIs and the new `@voyd-lang/web` package,
  with typed routing, extractors, middleware, response conversion, static files,
  cookies, request limits, cooperative timeouts, and VX-backed HTML responses.
- Added first-class external package functions and effects through `@external`,
  host package adapters, Node discovery, browser registries, generated
  TypeScript contracts, and generated WIT interfaces.
- Added `@voyd-lang/markdown`, the first external-package reference
  implementation. It converts Markdown into inert structured VX nodes without
  an `innerHTML` escape hatch.
- Added automatic typed SDK boundary exports for scalar and DTO values,
  including recursive optional DTOs, boundary validation, callback retention,
  and a direct scalar ABI fast path.
- Added `enum` to the standard prelude, `Eq` for `String` and `StringSlice`,
  `std::fs::remove`, optional structural fields, and fixes across overload
  resolution, generic inference, default parameters, closures, and effect
  lowering.
- Expanded release optimization with tiered `none`, `balanced`, and `release`
  policies, whole-program analysis, array and dispatch fast paths, effect
  specialization, call-shape specialization, and Binaryen closed-world GC
  optimization.
- Reduced aggregate raw Wasm by 6.66% and gzip size by 2.91% across the release
  optimizer scorecard. A minimal typed `i32` export dropped from 17,111 bytes to
  783 bytes and became 6.17x faster to dispatch through `runPure`.
- Reorganized validation into compiler-neutral conformance, public integration,
  and opt-in performance suites, with split CI lanes and regression budgets.

### Breaking Changes

- `std::fetch` has been removed. Use `std::http::client` for outbound HTTP.
- VX applications now use `app() -> Program<Model, Msg>` with `program({ init,
  step, view, subscriptions })` and return transitions through `next(...)`.
  Component state IDs are generated from stable call sites; the previous
  user-supplied `state(id:)` form has been removed.
- Runtime diagnostics and Binaryen validation are disabled by default for
  unoptimized compilation. Pass `runtimeDiagnostics: true` when those checks
  are required.
- Reference-bound (`~`) parameters cannot declare default values. Use an
  overload or callee-owned local storage instead.

### New Packages

- `@voyd-lang/web@0.3.0`
- `@voyd-lang/vx-dom@0.3.0`
- `@voyd-lang/package-adapter@0.3.0`
- `@voyd-lang/markdown@0.3.0`

### Package Versions

- `@voyd-lang/cli@0.3.0`
- `@voyd-lang/compiler@0.3.0`
- `@voyd-lang/js-host@0.3.0`
- `@voyd-lang/language-server@0.3.0`
- `@voyd-lang/lib@0.3.0`
- `@voyd-lang/markdown@0.3.0`
- `@voyd-lang/package-adapter@0.3.0`
- `@voyd-lang/reference@0.3.0`
- `@voyd-lang/sdk@0.3.0`
- `@voyd-lang/std@0.3.0`
- `@voyd-lang/vx-dom@0.3.0`
- `@voyd-lang/web@0.3.0`
- `voyd-vscode@0.3.0`

### Upgrade Notes

Install or update the CLI:

```sh
npm i -g @voyd-lang/cli@0.3.0
```

Update all directly consumed Voyd packages together. Existing VX applications
should migrate to the `Program<Model, Msg>` app contract, and code using
`std::fetch` should move to `std::http::client` before upgrading.

## Voyd v0.2.0 - M87* (2026-06-03)

Voyd `0.2.0` is a runtime and compiler release. The big theme is making
effectful programs feel more like ordinary Voyd programs: tasks, timers,
callback-style handlers, and a faster lowering/codegen path all moved forward
together.

### Highlights

- Added a same-run task runtime across the standard library, compiler, SDK, and
  JS host. New `std::task`, `std::async`, and timer/time APIs make it possible
  to spawn and await tasks while leveraging Voyd's effect model.
- Added full trailing callback clause support, so handler-heavy code and APIs
  that take callbacks can be written in a more natural surface syntax.
- Updated open effect row syntax and renamed `try forward` to `try open`, making
  forwarded/open effects read closer to the capability they expose.
- Added scalar replacement for non-escaping object locals and refactored it into
  an explicit codegen plan. This reduces unnecessary object materialization and
  gives the optimizer a clearer contract.
- Preloaded compiler codegen during graph loading and split slow CI paths, which
  should make day-to-day development and validation faster.
- Refactored type relations, type arena normalization, and effects IR boundaries
  so the compiler has a cleaner separation between typing, lowering, and codegen.
- Preserved structural field metadata and collapsed singleton unions in type
  interning, fixing several rough edges around structural typing and inferred
  union shapes.
- Fixed mutable value receiver lowering regressions and improved object init
  signature hints.

### Breaking Changes

- `try forward` has been renamed to `try open`.
- The open effect row syntax changed. Code using the older forwarded-effect
  spelling should be updated before compiling with `0.2.0`.
- All published Voyd packages now move together at `0.2.0`, including the CLI,
  compiler, SDK, JS host, standard library, reference docs, language server, and
  VS Code extension.

### Package Versions

- `@voyd-lang/cli@0.2.0`
- `@voyd-lang/compiler@0.2.0`
- `@voyd-lang/js-host@0.2.0`
- `@voyd-lang/language-server@0.2.0`
- `@voyd-lang/lib@0.2.0`
- `@voyd-lang/reference@0.2.0`
- `@voyd-lang/sdk@0.2.0`
- `@voyd-lang/std@0.2.0`
- `voyd-vscode@0.2.0`

### Upgrade Notes

Install or update the CLI:

```sh
npm i -g @voyd-lang/cli@0.2.0
```

If you consume Voyd packages directly, update internal package ranges together.
The release scripts keep Voyd's published packages in sync, and mixing `0.1.x`
compiler/runtime packages with `0.2.0` packages is not recommended.

## Voyd v0.1.0 - Sagittarius A* (2026-03-28)

Initial public release of Voyd, including the CLI, compiler, SDK, JS host,
standard library package, reference docs, language server, VS Code extension,
and documentation site.
