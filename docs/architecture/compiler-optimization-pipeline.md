# Compiler Optimization Pipeline

Status: Current
Owner: Compiler Architecture Working Group
Scope: `packages/compiler/src/pipeline-shared.ts`, `packages/compiler/src/optimize/*`, `packages/compiler/src/codegen/*`, `packages/lib/src/lib/binaryen-optimize.ts`

## Purpose

Voyd has a compiler-owned optimization layer between semantic linking and Wasm
codegen. Its job is to use Voyd semantic information while that information is
still explicit: types, effects, trait resolution, monomorphized instances,
call-shape metadata, capture sets, and constructor facts.

Binaryen remains responsible for Wasm-level cleanup and optimization after
Voyd has lowered the program. The compiler optimizer should not duplicate
Binaryen's generic local cleanup, CFG cleanup, Wasm peepholes, low-level
inlining, or Binaryen GC passes.

## Optimized Pipeline

The optimized whole-program path is:

1. Load and analyze modules.
2. Lower analyzed modules into ordered semantic modules.
3. `monomorphizeProgram(...)` builds callable instance metadata.
4. `buildProgramCodegenView(...)` builds the stable codegen-facing semantic
   view.
5. `optimizeProgram(...)` runs when `CodegenOptions.optimize` is enabled.
6. `codegenProgram(...)` receives the optimized program plus optimization facts.
7. Codegen emits a Binaryen module and, when optimized, runs the configured
   Binaryen optimization profile.

The optimization layer is invoked from both public emission paths in
`packages/compiler/src/pipeline-shared.ts`:

- `emitProgram(...)`
- `emitProgramWithContinuationFallback(...)`

Both paths build the same `ProgramCodegenView`, optionally call
`optimizeProgram(...)`, and pass `optimized?.program` plus `optimized?.facts`
into codegen.

## Ownership Boundary

The boundary between compiler optimization and codegen is
`ProgramCodegenView` plus `ProgramOptimizationFacts`.

The optimizer may:

- clone and mutate HIR in its own `ProgramOptimizationIR`
- rewrite compiler-level call metadata
- prune monomorphized instances and other semantic artifacts before codegen
- compute facts that tell codegen to choose a more direct lowering

The optimizer must not:

- mutate typing internals directly
- transform Binaryen IR
- perform generic Wasm-level peepholes
- infer broad escape/scalar-replacement behavior unless that is explicitly
  owned by a dedicated semantic pass

Codegen may consume optimization facts when choosing a lowering, but it should
still validate local preconditions at the use site. Facts are a guide to avoid
rediscovering semantic information, not permission to emit unsafe Wasm.

## Core Files

- `packages/compiler/src/optimize/ir.ts`
  - defines `ProgramOptimizationIR`, `ProgramOptimizationFacts`, and
    `ProgramOptimizationResult`
- `packages/compiler/src/optimize/pass.ts`
  - defines the pass interface and cached analysis API
- `packages/compiler/src/optimize/pipeline.ts`
  - builds the optimization IR, runs the pass list, and finalizes the optimized
    program/facts
- `packages/compiler/src/optimize/codegen-plan.ts`
  - contains longer-lived codegen planning data
- `packages/compiler/src/codegen/optimization/*`
  - contains small codegen helpers that consume optimizer facts
- `packages/lib/src/lib/binaryen-optimize.ts`
  - owns the shared Binaryen optimization profiles

## Optimization IR

`ProgramOptimizationIR` is built from `ProgramCodegenView` and the semantic
pipeline results. It keeps cloned module views so passes can mutate optimized
HIR without changing the original semantics-owned data.

The IR currently tracks:

- the original `ProgramCodegenView`
- the entry module id and selected codegen options
- optimized module views with cloned HIR/effect data
- normalized call lowering info per module/expression
- function instantiation metadata
- surviving monomorphized instances
- accumulated optimization facts

`ProgramOptimizationFacts` currently includes:

- reachable function instances and function symbols
- reachable module lets
- effect handler clause capture sets
- used trait-dispatch signatures
- receiver specialization requests
- exact and known parameter type facts
- whole-program escape facts for aggregate origins, trait-object receiver
  temporaries, closure environments, effect handler environments, and parameter
  boundary behavior
- runtime type-check elision candidates for field access
- semantic copy-forwarding candidates for field access
- a codegen optimization plan

## Pass API

Optimization passes implement this interface:

```ts
type ProgramOptimizationPass = {
  name: string;
  run(ctx: ProgramOptimizationContext): ProgramOptimizationPassResult;
};
```

`ProgramOptimizationContext` gives passes access to the IR and a small cached
analysis mechanism. Analyses are invalidated explicitly by returning
`invalidates` from a pass.

Current cached analysis keys are:

- `reachable-function-instances`
- `handler-captures`
- `trait-dispatch-signatures`

## Current Pass Order

The optimizer intentionally runs some passes more than once because earlier
rewrites can expose new exact-receiver, constructor, trait-dispatch, or
reachability facts.

The current pass list is:

1. `pure-compile-time-evaluation`
2. `simplify-boolean-branch`
3. `constructor-known-simplification`
4. `effect-fast-path-elimination`
5. `closure-environment-shrinking`
6. `continuation-and-handler-environment-shrinking`
7. `whole-program-specialization-pruning`
8. `exact-receiver-propagation`
9. `constructor-known-simplification`
10. `trait-dispatch-devirtualization`
11. `whole-program-specialization-pruning`
12. `exact-receiver-propagation`
13. `constructor-known-simplification`
14. `trait-dispatch-devirtualization`
15. `whole-program-specialization-pruning`
16. `redundant-runtime-type-check-elimination`
17. `semantic-copy-forwarding`
18. `whole-program-escape-analysis`

## Implemented Semantic Optimizations

### Pure Compile-Time Evaluation

Evaluates a controlled set of compiler-known pure expressions and intrinsics
when all inputs are compile-time constants. This is semantic constant
evaluation, not a generic arithmetic peephole pass.

### Boolean Branch Simplification

Simplifies branches whose condition is already known from earlier semantic
rewrites or constant evaluation.

### Constructor-Known Simplification

Uses constructor and exact nominal facts to simplify `Option`,
union/intersection, and tag-style checks before they lower into runtime
dispatch or type tests.

### Effect Fast-Path Elimination

Uses effect information to remove effect scaffolding when the compiler can
prove a callee is pure or an effect operation cannot be performed on a path.

### Closure Environment Shrinking

Shrinks closure environments before closure struct types are emitted, so unused
captures never become Wasm GC fields.

### Continuation And Handler Environment Shrinking

Prunes captured state from continuation and handler environments using
effect-lowering and handler capture facts.

### Whole-Program Specialization Pruning

Drops unreachable monomorphized instances, function symbols, module lets, trait
dispatch signatures, and helper artifacts before codegen emits them. Binaryen
can remove unused functions after emission, but it cannot prevent Voyd from
emitting unnecessary type metadata and helper shapes.

### Exact Receiver Propagation

Propagates exact and known parameter type facts across reachable call contexts.
These facts feed trait dispatch devirtualization, receiver specialization, and
runtime type-check elision.

### Trait Dispatch Devirtualization

Rewrites trait-method calls to direct calls when the concrete implementation is
known. This is not the same as Binaryen `directize`; Voyd is resolving language
trait dispatch before it becomes lower-level Wasm call/table behavior.

### Redundant Runtime Type-Check Elimination

Marks field accesses whose target type is semantically exact enough for codegen
to avoid guarded nominal field fast paths. Codegen still checks the exact
nominal precondition before emitting a direct field load.

### Semantic Copy Forwarding

Marks direct object-literal field access opportunities where fields can be
forwarded out of a freshly constructed aggregate without materializing the
aggregate. Codegen keeps this intentionally narrow: direct object-literal field
access without spreads, with all field initializers still evaluated in source
order.

This pass should remain separate from broader escape analysis and scalar
replacement. General non-escaping aggregate analysis belongs to `V-325` and
`V-326`, not this pass.

### Whole-Program Escape Analysis

Records conservative, reusable escape facts after reachability, exact receiver
propagation, and trait-dispatch devirtualization have stabilized. The facts are
available through `ProgramOptimizationFacts.escapeAnalysis` and cover:

- aggregate origins such as object literals and tuples
- trait-object receiver temporaries at direct call boundaries
- closure environment origins and captured aggregate escapes
- effect handler environment origins and captured aggregate escapes
- per-function-instance parameter escape behavior

The pass intentionally does not scalar-replace aggregates or skip
materialization by itself. Downstream codegen and SROA work must consume these
facts and re-check local lowering preconditions before changing representation.

## Codegen-Owned Lowering Optimizations

Some performance-sensitive lowering choices belong in codegen instead of the
optimization pass manager because the needed facts are local to lowering state.

### Addressable Wide-Local Scratch Lowering

Addressable wide-local scratch lowering is handled as codegen lowering, tracked
by `V-331`, not as a `V-309` optimizer pass.

The implemented shape is:

- `compilePatternInitialization(...)` detects when a binding has reusable
  addressable storage.
- Wide value-object, tuple, optional, and compatible call construction can
  receive an `outResultStorageRef` and store directly into that storage.
- Control-flow and call lowering can forward the same out-result storage through
  compatible regions.
- Mutable-ref call arguments materialize addressable local storage when needed.

This covers the narrow intent from the original architecture plan: reuse
already-addressable local or out-result storage for wide value/inline aggregate
construction and mutation within the current lowering region.

It does not compute whole-program escape facts, and it does not split
aggregates into scalar locals. Reusable escape facts are owned by the
whole-program escape-analysis pass; broad scalar replacement and allocation
elision remain separate `V-326` work.

### Scalar Aggregate Replacement

Scalar aggregate replacement is a codegen-owned consumer of
`ProgramOptimizationFacts.escapeAnalysis`. It does not mutate optimized HIR and
does not infer escape behavior from local syntax alone. Codegen may split a
local aggregate into field locals only when all of these checks pass:

- the origin fact exists, is an `aggregate`, has the expected type id, does not
  escape, and names the local symbol as a direct local symbol
- the initializer is a direct object literal without spreads, a tuple literal, a
  block/conditional expression whose branch values meet these same checks, or a
  small value-object direct-call result
- the structural layout is small enough for local lane storage
- all fields are initialized directly or are optional fields that can receive
  the normal `None` value

The scalar binding rematerializes through `initStructuralValue` when a full
value is needed, and mutable-ref or storage boundaries continue to use the
existing materialization paths. Direct value-object parameters whose parameter
escape facts are non-escaping can bind incoming ABI lanes directly to field
locals. Direct calls with scalarized heap-object identifier arguments, direct
heap-object literal arguments, or simple heap-object factory returns may also
use a private callee specialization whose selected parameters or result receive
field lanes instead of a heap reference, leaving the original public ABI
unchanged. Whole-object heap assignment remains a materialization boundary to
preserve object identity; value-object reassignment may stay scalar.

Unsupported shapes deliberately fall back to the existing materialized
aggregate path. This keeps the implementation removable and avoids coupling
codegen to typing internals beyond the codegen-view and optimization-facts
contracts.

The complexity added by this path is:

- one new local binding representation for scalar aggregate lanes
- localized field load/store/rematerialization helpers
- a private direct-call specialization path for selected small heap-object
  parameters and fresh heap-object results
- additional local rechecks for mutable method receivers, effectful functions,
  effect-handler captures, aliasing, and storage-ref capture boundaries

It avoids a separate optimizer rewrite pass and keeps the public function ABI
unchanged, but it does add coupling between escape facts, call metadata, and
codegen lowering. The main maintenance risks are stale lane values after
mutation/capture boundaries and accidentally specializing alias-returning heap
objects. The implementation pays a compile-time cost in the affected scenarios
for extra fact checks and specialization metadata, but the hot aggregate cases
below show runtime and code-size wins where Binaryen alone did not remove the
semantic allocation pattern. Effectful functions deliberately fall back to
materialized values until storage/capture semantics can be proven more tightly.

Rejected simpler alternatives:

- local-only pattern matching was too fragile around aliases, method receivers,
  effect handlers, and public boundary wrappers
- relying only on Binaryen missed mutable object temporaries and selected direct
  call shapes
- a broad optimizer rewrite pass would duplicate codegen ownership of storage
  refs, projected elements, and ABI lowering
- doing nothing left aggregate-heavy mutable/direct-call code dependent on GC
  allocation patterns in hot loops

`scripts/bench-v326.ts` emits revision-tagged raw CSV and can compare two runs:

```sh
VOYD_BENCH_OPTIMIZE_MODES=true VOYD_BENCH_REVISION=base-484fcd76 \
  node --conditions=development --import tsx scripts/bench-v326.ts > /tmp/v326-base.csv
VOYD_BENCH_OPTIMIZE_MODES=true VOYD_BENCH_REVISION=head-worktree \
  node --conditions=development --import tsx scripts/bench-v326.ts > /tmp/v326-head.csv
node --conditions=development --import tsx scripts/bench-v326.ts \
  compare /tmp/v326-base.csv /tmp/v326-head.csv
```

PR-base (`484fcd76`) vs PR-head validation. Shape columns are whole-module WAT
counts; runtime is median host-run time:

| Scenario | Runtime ms base -> head | Runtime delta | Compile ms delta | Wasm bytes delta | WAT bytes delta | `struct.new` delta | `tuple.make` delta |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| focused/non-escaping-object-local | 0.082 -> 0.067 | -18.3% | +5.3% | -0.3% | -0.2% | -3 | 0 |
| focused/mutable-object-temporary | 0.104 -> 0.053 | -49.0% | +17.7% | -0.3% | -0.2% | -3 | 0 |
| focused/direct-value-call-argument | 0.057 -> 0.049 | -14.0% | +7.8% | -0.3% | -0.2% | -3 | 0 |
| focused/direct-heap-call-argument | 0.060 -> 0.047 | -21.7% | +18.4% | -0.3% | -0.2% | -3 | 0 |
| focused/direct-heap-call-literal | 0.046 -> 0.050 | +8.7% | +4.7% | -0.3% | -0.2% | -3 | 0 |
| focused/direct-heap-call-return | 0.054 -> 0.047 | -13.0% | -0.0% | -0.3% | -0.2% | -3 | 0 |
| focused/escape-boundary-rematerialization | 0.047 -> 0.047 | 0.0% | +2.0% | -0.3% | -0.2% | -3 | 0 |
| representative/scalar-aggregate-particle-step | 0.547 -> 0.033 | -94.0% | +0.4% | -1.9% | -1.3% | -4 | 0 |
| representative/vtrace-compute-main | 271.129 -> 264.969 | -2.3% | +6.1% | +0.9% | +1.5% | +11 | +4 |

The particle-step fixture is the in-repo representative aggregate-heavy
workload affected by this optimization. `vtrace-compute-main` is retained as a
broader guardrail; after effectful-function bailouts it shows small runtime
movement and code-size growth while the aggregate-heavy representative case
improves. The
optional `/Users/drew/projects/voyd_examples`
scenario is included in the script when present, but the current local checkout
uses older `while ... do:` syntax and is skipped with a warning by this
compiler.

## Binaryen Optimization

After Voyd codegen emits the Binaryen module, `CodegenOptions.optimize` runs
the shared helper in `@voyd-lang/lib/binaryen-optimize`.

The compiler supports two profiles:

- `standard`
  - Binaryen optimize level 2
  - Binaryen shrink level 1
  - `module.optimize()`
- `aggressive`
  - Binaryen optimize level 3
  - Binaryen shrink level 2
  - `module.optimize()`
  - extra validated passes
  - a second `module.optimize()`

The current aggressive extra passes are:

- `const-hoisting`
- `heap-store-optimization`
- `heap2local`
- `licm`
- `merge-locals`
- `merge-similar-functions`
- `optimize-casts`
- `precompute-propagate`
- `tuple-optimization`

`aggressive` is the default optimized profile in codegen. The SDK exposes the
coarse `optimize?: boolean` switch, not raw Binaryen pass configuration.

## Explicit Non-Goals

The compiler optimizer should not own:

- arithmetic peepholes
- generic local.get/local.set cleanup
- generic inlining heuristics
- loop-invariant code motion unless it depends on Voyd-only semantics
- Wasm CFG cleanup
- stack-machine shaping
- low-level GC heap store optimization
- generic scalar replacement without a dedicated semantic pass

If a transform can be expressed purely as a Wasm or Binaryen-IR pass, Binaryen
or the shared Binaryen optimization profile should own it.

## Known Open Work

- `V-316`: call-shape specialization remains a backlog optimizer pass. Current
  codegen already consumes resolved call lowering metadata, but there is no
  standalone optimizer pass that specializes call shapes beyond the existing
  call info and receiver-specialization facts.
- `V-325`: reusable whole-program escape facts are present. Downstream
  representation changes must consume those facts through
  `ProgramOptimizationFacts.escapeAnalysis` rather than rediscovering typing
  internals.
- Heap-object direct-call scalar ABI specialization is private to selected
  direct calls and preserves the original function metadata for public exports,
  trait dispatch, closure values, imports, and other non-specialized calls. It
  is used only when object identity is not exposed across the optimized
  boundary.

## Testing Guidance

Use the narrowest layer that owns the behavior:

- `packages/compiler/src/__tests__/optimize-pipeline.test.ts`
  - optimizer facts, optimized call metadata, pruned instances, and codegen
    effects of optimizer facts
- `packages/compiler/src/codegen/__tests__`
  - local lowering behavior such as out-result storage and addressable scratch
    paths
- `apps/smoke`
  - end-to-end public behavior and realistic integration checks
- benchmark scripts
  - performance/code-size decisions for optimizations whose value is uncertain

Avoid tests that only assert Binaryen's internal text output unless the test is
protecting a Voyd-owned lowering decision that would otherwise be invisible.

## Maintenance Rules

- Keep new optimizer facts explicit in `ProgramOptimizationFacts`.
- Keep codegen fact consumers local and removable.
- Re-run meaningful benchmarks before adding broad or complex passes.
- Prefer a narrow semantic pass over general data-flow machinery until a real
  benchmark shows the broader machinery pays for itself.
- Keep `V-318`-style immediate forwarding separate from `V-325`/`V-326` escape
  analysis and scalar replacement.
- Keep `V-331`-style addressable storage reuse in codegen unless it needs
  reusable semantic facts that belong in the optimizer.
