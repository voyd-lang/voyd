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

It does not own reusable whole-program escape facts, and it does not split
aggregates into scalar locals. It also does not remove allocation for arbitrary
nominal `obj` locals. Those responsibilities belong to the broader value-like
workload roadmap: `V-325` for escape facts and `V-326` for scalar replacement.

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
- `V-325`: reusable whole-program escape facts remain outside this optimizer
  layer until a benchmark justifies the added analysis surface.
- `V-326`: broad scalar replacement for non-escaping aggregates remains
  separate from semantic copy forwarding and addressable storage reuse.

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
