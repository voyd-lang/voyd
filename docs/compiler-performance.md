# Performance Log

## Optimizer scorecard

The canonical optimizer benchmark is `scripts/bench-optimizer.ts`. It replaces
the ticket-specific optimizer benchmark scripts as the ongoing regression
signal; those older scripts remain available only to reproduce their historical
results.

Run the quick local scorecard:

```sh
npm run bench:optimizer
```

Run the hermetic PR corpus with three fresh-process compile samples per case:

```sh
npm run bench:optimizer:ci -- --output /tmp/optimizer-scorecard.json
```

Run the full nightly corpus at `none`, `balanced`, and `release`:

```sh
npm run bench:optimizer -- --preset full --output /tmp/optimizer-scorecard.json
```

Run the full release-profile Binaryen ablation matrix (one fresh-worker case
for each aggressive extra pass and the final optimization cycle):

```sh
npm run bench:optimizer:ablate -- --output /tmp/optimizer-ablation.json
```

For a focused investigation, omit one target with
`--binaryen-ablation heap2local` (or `final-optimize`) and select scenarios with
`--scenarios`. Every matrix includes an unchanged release baseline.

Compare two saved scorecards:

```sh
npm run bench:optimizer:compare -- \
  --base-json /tmp/base.json \
  --head-json /tmp/head.json
```

The scorecard uses a fresh child process for every compile warmup and measured
sample. Compile timing and peak compile RSS exclude runtime execution and WAT
emission. After the timed compile it validates
the Wasm, measures gzip and structural shape counts, checks deterministic bytes
across identical compiles, and runs the public entrypoint after a warmup. It
also records compiler phase timings, ordinal optimizer-pass metrics, codegen
optimization decisions, Binaryen stage timings, peak process RSS, and raw
timing/heap/RSS samples in schema-versioned JSON. Schema v2 identifies each row
by scenario, optimization level, and experiment. Base/head comparison snapshots the benchmark sources
before either checkout so both compilers receive byte-identical corpus input;
the scorecards also record per-scenario source hashes.

The PR gate fails only when both the relative and absolute thresholds are
exceeded:

| Metric         | Relative |   Absolute |
| -------------- | -------: | ---------: |
| Compile median |     +20% |    +250 ms |
| Runtime median |     +20% |      +5 ms |
| Peak RSS       |     +15% |    +32 MiB |
| Wasm size      |      +5% |     +1 KiB |
| Gzip size      |      +5% | +512 bytes |

Structural and pass counters are reported but are not hard gates: an increase
can be correct when it unlocks a larger runtime win. Thresholds can be
overridden through the `OPTIMIZER_BENCH_*` environment variables or the
corresponding comparison-script flags. The scheduled
`.github/workflows/optimizer-scorecard.yml` workflow runs the full corpus and
retains its JSON artifact for 30 days.

The PR regression gate intentionally benchmarks the release level through both
the explicit level and legacy boolean. This lets the head-owned harness compare
against revisions that predate optimization levels without silently measuring
an unoptimized base. Balanced and ablation investigations are current-tree or
saved-scorecard workflows.

Compiler perf summaries are versioned and enabled with
`VOYD_COMPILER_PERF=1`. Optimizer passes emit both aggregate and canonical
ordinal counters, for example:

```text
optimize.pass.7.exact-receiver-propagation.ms
optimize.pass.7.exact-receiver-propagation.changed
optimize.pass.7.exact-receiver-propagation.exact_parameter_facts
```

Missing counters represent zero because the low-overhead counter collector does
not store zero increments.

**10 Jul 2026 - call-shape specialization**

The final semantic-optimizer schedule now plans concrete call shapes for
defaulted, omitted optional, and stable-callsite parameters. Codegen emits
private compact-ABI clones under the shared specialization admission ledger;
labels and structural-container extraction remain caller-owned. The original
ABI remains available whenever planning, semantic revalidation, or any budget
rejects a request.

The quick scorecard includes `call-shape-defaults`, a 50,000-iteration mixed
omitted/provided recursive labeled-default workload. Run it directly with:

```sh
npm run bench:optimizer -- --scenarios call-shape-defaults \
  --modes unoptimized,release --runtime-samples 5
```

The implementation run selected five reachable calls across four reusable
shapes. Codegen admitted four clones, reused them at three later calls, removed
three ABI parameters and two default-selection branches, and Binaryen inlined
the private clones in the final release artifact. The focused pre-Binaryen WAT
test shows the recursive function changing from three physical parameters
(value plus Optional tag/payload) to two for the supplied shape and one for the
omitted shape. Runtime tests also cover default side effects exactly once,
plain optional omission, structural labeled containers, generic imports, wide
values, stable-ID sharing, and budget fallback.

**10 Jul 2026 - std contracts and centralized specialization admission**

Compiler/std optimization dependencies now use semantic role metadata instead
of duplicated source-name, module-path, and structural heuristics.
`@compiler_contract` gives each boundary MsgPack helper a stable
`voyd.std.boundary.msgpack.*` function role, while compiler-recognized std
containers use `@intrinsic_type` nominal IDs. Binding rejects unknown roles,
wrong arities, non-std or nested providers, and the program symbol arena rejects
duplicate providers. At feature use, the typed signature catalog validates the
entire MsgPack ABI (shared types, primitives, fixed arrays, generics,
optionality, and effects) before codegen emits boundary calls. Missing or
incompatible roles fail clearly; there is no silent name-based fallback.

All function-body specializations now share the frozen
`SpecializationPolicy` carried by `ProgramCodegenOptimizationPlan`. Eligibility
and semantic safety remain owned by their optimization/lowering sites. The
central policy only caps already-safe receiver, scalar-aggregate, static-effect,
and direct-trait-switch work. A program-scoped admission ledger composes all
active specialization dimensions into one identity and enforces per-kind,
per-function, per-program, and estimated duplicated-body-node budgets. This
prevents independent specialization features from colliding or multiplying
code size without a common bound.

The scorecard records admission demand and outcomes with these counters for
each specialization kind:

```text
codegen.specialization.<kind>.requested
codegen.specialization.<kind>.admitted
codegen.specialization.<kind>.reused
codegen.specialization.<kind>.rejected.kind_budget
codegen.specialization.<kind>.rejected.per_function_budget
codegen.specialization.<kind>.rejected.program_budget
codegen.specialization.<kind>.rejected.code_size_budget
codegen.specialization.<kind>.estimated_body_nodes
```

These are diagnostic counters rather than hard PR gates. Compare requested,
admitted, rejected, and estimated-node movement alongside compile time, runtime,
and Wasm size when tuning a budget. Missing counters mean zero.

**9 Jul 2026 - indexed semantic optimizer and convergence schedule**

Replaced repeated whole-program HIR discovery in the semantic optimizer with a
shared program/body index and set-backed worklists. Exact/known receiver
analysis now shares one indexed call-site view per pass, reachability indexes
trait signatures and queue membership, and parameter escape propagation
reprocesses only reverse callers whose downstream facts grew. The schedule now
runs structural passes to a checked fixed point before computing capture and
escape facts; a program-size-derived iteration budget reports genuine
non-convergence rather than accepting a partially converged result or rejecting
a fixed-depth valid chain.

The three-sample CI corpus compared the pre-change implementation with the
indexed implementation in fresh processes. All three cases produced
byte-identical Wasm:

| Scenario         | Optimizer before | Optimizer after | Hot analyses before | Hot analyses after |
| ---------------- | ---------------: | --------------: | ------------------: | -----------------: |
| tier1 trait call |        209.73 ms |       149.84 ms |           145.36 ms |           70.74 ms |
| scalar aggregate |        209.72 ms |       150.43 ms |           145.64 ms |           72.01 ms |
| vtrace main      |        328.64 ms |       215.27 ms |           256.16 ms |          125.35 ms |

“Hot analyses” is exact/known receiver propagation plus whole-program pruning
and escape analysis. The vtrace optimizer median fell 34.5%; its full compile
median fell from 3329.38 ms to 3194.16 ms (4.1%). The body-index and worklist
counters remain in scorecard output so future changes can distinguish useful
analysis work from traversal regressions.

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
- `TypeArena` is cloneable through an internal snapshot of descriptors,
  descriptor cache canonical ids, schemes, recursive unfold cache, and ID
  counters. Restored arenas preserve the same canonical type ids as the
  original arena.
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

| Scenario                                | Fresh app-edit ms | Snapshot app-edit ms | Saved ms | Saved |
| --------------------------------------- | ----------------: | -------------------: | -------: | ----: |
| `smoke/std-math-transcendentals`        |          2718.375 |             1959.845 |  758.530 | 27.9% |
| `smoke/scalar-aggregate-representative` |          2218.074 |             1608.122 |  609.952 | 27.5% |
| `smoke/vtrace-compute-main`             |          5369.959 |             4756.137 |  613.822 | 11.4% |
| `smoke/vtrace-compute-benchmark`        |          5384.718 |             4687.184 |  697.534 | 13.0% |
| `voyd_examples/ray-vtrace-tuned`        |          5787.530 |             5157.944 |  629.586 | 10.9% |

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

| Compiler benchmark                                  |      hz | mean ms | p75 ms | p99 ms | samples |
| --------------------------------------------------- | ------: | ------: | -----: | -----: | ------: |
| `typing overload fanout (48 candidates)`            | 4979.64 |  0.2008 | 0.2085 | 0.3980 |    2490 |
| `typing union-heavy type satisfaction (80 members)` | 2520.85 |  0.3967 | 0.3934 | 1.2552 |    1261 |

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
that slows us down substantially. They are both slow and can only run _after_
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
