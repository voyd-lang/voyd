# Performance Log

**21 Jun 2026 - V-375 dependency semantic snapshots**

Added compiler-owned dependency semantic snapshots for repeated
`createSdk().compile(...)` calls where app code changes between compiles:

- The cache snapshots only non-`src` modules (`std` and installed `pkg`
  modules). A one-line app edit reuses the dependency snapshot and recomputes
  `src` modules against a cloned typing state.
- The key includes a compiler snapshot version, `includeTests`, dependency root
  inputs (`std`, `pkg`, `pkgDirs`), and fingerprints of every non-`src` module:
  source, source files, origin, dependencies, source package root, and macro
  exports.
- App source is intentionally not part of the dependency snapshot key. App
  changes reuse the snapshot; std/package source changes miss and rebuild it.
- Dynamic `resolvePackageRoot` disables reuse because resolver state is not
  safely fingerprintable.
- There is no whole-graph wasm artifact cache in this path. Every app edit still
  re-emits wasm, so runtime bytes may change even when behavior does not.

Snapshot safety:

- The snapshot freezes a cloned dependency semantics map at the pre-`src`
  boundary. This avoids source-time generic/type mutations leaking back into the
  cached std/pkg state.
- `TypeArena` is cloneable through an internal snapshot of descriptors, schemes,
  recursive unfold cache, and ID counters. Its descriptor cache is rebuilt with
  first occurrence wins so noncanonical duplicate descriptor slots do not become
  canonical after cloning.
- `EffectInterner`, `EffectTable`, `TypeTable`, and the typing stores are
  cloned into the per-compile arena/effect state. Source modules get an overlay
  typing state; cached dependency modules never share mutable emit-time state
  with the next compile.
- The SDK tests cover app edits, std edits, installed package edits, and a
  generic-heavy vtrace app edit that validates and runs the warm wasm.

The warm edit appends a tiny private marker function to the app source, so the
benchmark mutates the parsed AST while preserving the measured entrypoint result.

Benchmark command:

```sh
VOYD_COMPILER_LATENCY_REPEATS=2 VOYD_COMPILER_LATENCY_VTRACE_RUNTIME_SAMPLES=0 npm run bench:compiler-latency
```

Baseline mode approximating no dependency snapshot reuse:

```sh
VOYD_COMPILER_LATENCY_FRESH_SDK=1 VOYD_COMPILER_LATENCY_REPEATS=2 VOYD_COMPILER_LATENCY_VTRACE_RUNTIME_SAMPLES=0 npm run bench:compiler-latency
```

Local M-series run, optimized mode, one-line app edit between iterations:

| Scenario | Fresh app-edit ms | Snapshot app-edit ms | Saved ms | Saved |
| --- | ---: | ---: | ---: | ---: |
| `smoke/std-math-transcendentals` | 2718.375 | 1959.845 | 758.530 | 27.9% |
| `smoke/scalar-aggregate-representative` | 2218.074 | 1608.122 | 609.952 | 27.5% |
| `smoke/vtrace-compute-main` | 5369.959 | 4756.137 | 613.822 | 11.4% |
| `smoke/vtrace-compute-benchmark` | 5384.718 | 4687.184 | 697.534 | 13.0% |
| `voyd_examples/ray-vtrace-tuned` | 5787.530 | 5157.944 | 629.586 | 10.9% |

`VOYD_COMPILER_PERF=1` on `smoke/vtrace-compute-main` showed the warm app-edit
compile hitting the snapshot for all 49 std modules. The profiled cold compile
spent about 970 ms in semantic analysis and 4689 ms in emit; the warm app-edit
spent about 172 ms in semantic analysis and 4411 ms in emit. The remaining
optimized latency is therefore dominated by whole-program emit/codegen rather
than std typing.

The optional suite benchmark at
`/Users/drew/projects/voyd_examples/benchmarks/suite/voyd/benchmarks.voyd`
still fails before codegen with `cannot overload log; module with the same name
already exists`, so it is skipped by the harness. The ray vtrace external
scenario at
`/Users/drew/projects/voyd_examples/benchmarks/ray/voyd/vtrace_tuned.voyd`
compiled successfully.

Existing compiler perf benchmark baseline from the same run shape:

| Compiler benchmark | hz | mean ms | p75 ms | p99 ms | samples |
| --- | ---: | ---: | ---: | ---: | ---: |
| `typing overload fanout (48 candidates)` | 4979.64 | 0.2008 | 0.2085 | 0.3980 | 2490 |
| `typing union-heavy type satisfaction (80 members)` | 2520.85 | 0.3967 | 0.3934 | 1.2552 | 1261 |

**20 Feb 2026**

Added debug-only compiler perf instrumentation behind `VOYD_COMPILER_PERF=1`.

- Compile-phase timings are emitted from `compileProgramWithLoader` as:
  - `loadModuleGraph`
  - `analyzeModules`
  - `emitProgram`
  - `total`
- Hot counters include:
  - graph traversal queue behavior (`graph.pending.*`, `graph.nested.*`)
  - typing current-function constraint-cache behavior (`typing.constraint_cache.*`)
  - union-binding search behavior (`typing.union_search.*`)

Example:

```sh
VOYD_COMPILER_PERF=1 vt --run ./path/to/main.voyd
```

The compiler prints a single structured summary line prefixed with
`[voyd:compiler:perf]` for each compile invocation.

**12 Feb 2026**

Added typing performance guardrails and CI benchmarks:

- `packages/compiler/src/semantics/typing/__tests__/typing.bench.ts` covers
  overload fanout and union-heavy typing paths.
- CI now runs `npm run --workspace @voyd-lang/compiler bench:typing` in
  `.github/workflows/pr.yml`.

Typing disambiguation policy:

- If overload disambiguation would require global backtracking, require explicit
  type arguments or expected-type annotations instead of adding heuristic search.

**16 Aug 2025**

Time to parse ~0.19 MB Voyd File (M1 Pro 16GB). Average of 124.68 ms. Relatively
slow. But not terrible considering how flexible the architecture is.

Notes. I played around a but with some minor improvements. Removing most of
the reader macros, leaving only identifier and list macros, had a negligible
impact on performance of parseChars.

The performance of parse chars is actually pretty quick. Its the syntax macros
that slows us down substantially. They are both slow and can only run *after*
the reader macros. Maybe there is a way to merge the two in the future.

```
 ✓ src/parser/__tests__/parser.bench.ts 3131ms
     name                                               hz      min      max     mean      p75      p99     p995     p999     rme  samples
   · parser performance (excluding syntax-macros)  18.9460  49.3119  58.1684  52.7817  54.7330  58.1684  58.1684  58.1684  ±3.66%       10
   · full parser performance                        7.9014   121.93   135.38   126.56   129.88   135.38   135.38   135.38  ±2.58%       10

 ✓ src/parser/__tests__/parser.bench.ts 3131ms
     name                                               hz      min      max     mean      p75      p99     p995     p999     rme  samples
   · parser performance (excluding syntax-macros)  18.9460  49.3119  58.1684  52.7817  54.7330  58.1684  58.1684  58.1684  ±3.66%       10
   · full parser performance                        7.9014   121.93   135.38   126.56   129.88   135.38   135.38   135.38  ±2.58%       10

 BENCH  Summary

  parser performance (excluding syntax-macros) - src/parser/__tests__/parser.bench.ts
    2.40x faster than full parser performance
```
