# Language Conformance

The conformance corpus is the portable contract for a Voyd compiler. A future
compiler written in Voyd should be able to run the same manifest by providing
an adapter; it should not need to reproduce TypeScript compiler internals.

## Structure

```text
tests/conformance/
  manifest.json
  cases/
    effects/
    modules/
    runtime/
    syntax/
    typing/
  src/
    compiler-adapter.ts
    current-compiler-adapter.ts
    load-compiler-adapter.ts
    manifest.ts
    run-conformance.ts
    *.test.ts
```

Each manifest suite identifies one module tree and compilation configuration.
Its cases share that compilation, which avoids repeatedly compiling std and the
same source. Cases have stable dotted IDs and assert one of:

- compilation succeeds;
- compilation fails with stable diagnostic codes and, only when useful,
  selected message fragments;
- an exported entrypoint returns a JSON-compatible value;
- a numeric result lies in an explicit range;
- execution produces a normalized trap;
- scripted host effects produce an expected interaction trace; or
- emitted Wasm has required exports/imports and omits forbidden imports.

Keep the adapter surface small and normalized rather than exposing
compiler-specific objects.

The reviewed compiler inventory distinguishes linked portable coverage from
explicit portable backlog. `compiler-local-portable-gap` means a detailed test
correctly remains with the current compiler but a future implementation does
not yet have an equivalent manifest case; it must never be treated as covered
by a merely related case. Partial extractions retain both the exact case IDs and
the remaining gap text.

## Portability Rules

- Cases contain Voyd source and observable expectations.
- Runner code may depend on the adapter interface, not compiler internals.
- Do not snapshot internal AST, HIR, symbol or optimizer representations.
- Prefer diagnostic codes over complete messages.
- Group cases only when they share a coherent subsystem and compile options.
- Stable case IDs describe capabilities, not bugs or implementation phases.

The current adapter uses `@voyd-lang/sdk`. Another compiler can implement
`ConformanceCompilerAdapter`, export `createConformanceCompilerAdapter()` from
a JavaScript bridge module, and run the same corpus with:

```sh
VOYD_CONFORMANCE_ADAPTER=/absolute/path/to/adapter.js \
  npm run --workspace @voyd-lang/conformance-tests test
```
