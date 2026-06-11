# V-325 Escape Analysis Notes

Status: implemented as reusable optimizer facts.

## Implemented Surface

V-325 adds `ProgramOptimizationFacts.escapeAnalysis` as the compiler/codegen
boundary contract for escape facts. The pass runs after reachability,
exact-receiver propagation, trait-dispatch devirtualization, runtime type-check
elision marking, and semantic copy-forwarding marking.

The fact surface records:

- aggregate origins from object literals and tuple expressions
- trait-object receiver temporaries at direct call boundaries
- closure environment origins
- effect handler environment origins
- per-function-instance parameter escape behavior

Facts are conservative. Unknown calls, dynamic dispatch, effectful calls,
mutable-ref call arguments, returns, public exports, aggregate storage, closure
captures, and effect handler captures are treated as escapes. Direct pure calls
can keep an aggregate non-escaping when the callee parameter is proven
non-escaping by the whole-program fixpoint.

## Complexity Proof

New compiler concepts:

- `EscapeAnalysisOriginFact`
- `EscapeAnalysisParameterFact`
- origin kinds for aggregates, trait objects, closure environments, and effect
  handler environments
- escape reasons suitable for downstream diagnostics and representation
  decisions

Pass-ordering dependency:

- The pass intentionally runs late so it consumes the optimized reachable
  instance set and devirtualized call info. Running earlier would mark direct
  calls and trait receivers as unknown more often.

Boundary coupling:

- The pass uses `ProgramCodegenView`, optimized HIR, optimized call metadata,
  and existing function/effect/type indexes.
- Codegen receives facts through `ProgramOptimizationFacts`. It does not import
  typing stores or optimizer internals.

Maintenance risk:

- The main risk is conservative false negatives when new HIR forms gain
  ownership semantics. Those should add escape reasons/tests rather than
  weakening existing facts.
- The pass does not rewrite HIR and does not mutate call metadata, so incorrect
  facts are less likely to create immediate correctness bugs unless a downstream
  lowering consumes them without re-checking local preconditions.

Expected compile-time cost:

- Linear in reachable optimized HIR roots, plus a monotonic parameter fixpoint
  over reachable direct call edges.
- The fact map is proportional to reachable aggregate/lambda/effect-handler
  origins plus reachable function parameters.

Simpler alternatives:

- Local-only escape analysis was rejected because it cannot distinguish direct
  pure call boundaries from functions that return/store parameters.
- Reusing exact receiver facts alone was rejected because it only answers
  concrete type identity, not whether value identity/materialization escapes.
- Doing nothing would leave V-326 and value-lane forwarding without a stable
  boundary contract.

Why land this now:

- The pass establishes the reusable contract needed by V-326 without coupling
  codegen to typing internals.
- Tests cover positive non-escaping aggregates, returned/call-boundary escapes,
  public boundary escapes, trait-object receiver temporaries, closure captures,
  and effect handler captures.
- No scalar replacement or object materialization elision is enabled in this
  patch. Those transformations must consume these facts later and prove their
  own local lowering preconditions.

## Benchmark Command

Run from the repository root:

```sh
NODE_OPTIONS=--conditions=development \
  VOYD_BENCH_ITERATIONS=1 \
  VOYD_BENCH_REPRESENTATIVE_ITERATIONS=1 \
  npx tsx scripts/bench-v325.ts
```

The `development` condition is needed in an unbuilt workspace so Node resolves
workspace TypeScript sources instead of `dist` package exports.

## Baseline Run

Machine/date: local Codex worktree, 2026-06-11.

```csv
name,optimize,compileMs,wasmBytes,gzipBytes,medianMs,samplesMs
focused/non-escaping-aggregate,false,1813.767,51994,14230,0.270,0.270
focused/non-escaping-aggregate,true,2686.846,18154,6584,0.168,0.168
focused/mutable-temporary-record,false,1430.948,51994,14230,0.257,0.257
focused/mutable-temporary-record,true,2415.187,18154,6584,0.666,0.666
focused/trait-typed-temporary,false,1335.653,51994,14230,0.349,0.349
focused/trait-typed-temporary,true,2371.753,18154,6584,0.058,0.058
focused/call-boundary-escape,false,1337.524,51994,14230,0.523,0.523
focused/call-boundary-escape,true,2365.108,18154,6584,0.068,0.068
representative/vtrace-compute-main,false,1797.738,173132,44619,995.187,995.187
representative/vtrace-compute-main,true,5825.309,60098,19436,277.359,277.359
```

These numbers are end-to-end optimized versus unoptimized baselines for the
current compiler. V-325 does not claim a WAT/codegen shape change by itself; the
new facts are the shape contract for downstream V-326 materialization and SROA
work.

## External Examples Status

`/Users/drew/projects/voyd_examples` is not currently a clean benchmark target:

- `/Users/drew/projects/voyd_examples/src/vtrace_fast.voyd` is absent.
- `/Users/drew/projects/voyd_examples/src/main.voyd` fails to compile with
  `undefined identifier 'forward'` and an unavailable `src::pkgs::vtrace::pkg`
  import under the current compiler.

The benchmark script keeps the old `vtrace_fast.voyd` hook optional so it will
participate automatically if that fixture is restored.
