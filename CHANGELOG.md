# Changelog

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
