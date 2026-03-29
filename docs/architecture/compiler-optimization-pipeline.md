# Compiler Optimization Pipeline

Status: Proposed
Owner: Compiler Architecture Working Group
Scope: `packages/compiler/src/pipeline-shared.ts`, new `packages/compiler/src/optimize/*`, `packages/compiler/src/codegen/*`, `packages/sdk/src/node.ts`

## Goal

Introduce a compiler-owned optimization layer before Wasm codegen, while keeping Binaryen responsible for Wasm-level and Binaryen-IR-level optimization.

The design goal is not "replace Binaryen". The goal is to do the optimizations that require Voyd semantic information before that information is erased by lowering to Wasm.

## Current Pipeline

Today the relevant whole-program pipeline is:

1. Analyze modules.
2. `monomorphizeProgram(...)`
3. `buildProgramCodegenView(...)`
4. `codegen.codegenProgram(...)`
5. Binaryen `module.optimize()` when `CodegenOptions.optimize` is enabled
6. In `@voyd-lang/sdk`, read emitted wasm back into Binaryen and run another `module.optimize()`

The current call sites are:

- `packages/compiler/src/pipeline-shared.ts`
  - `emitProgram(...)`
  - `emitProgramWithContinuationFallback(...)`
- `packages/compiler/src/codegen/codegen.ts`
  - `mod.optimize()`
- `packages/sdk/src/node.ts`
  - `binaryen.setShrinkLevel(3)`
  - `binaryen.setOptimizeLevel(3)`
  - `module.optimize()`

This means Voyd currently relies on Binaryen for all optimization after language lowering. There is no compiler-owned optimization stage between semantic linking and Wasm emission.

## What Binaryen Already Does

This repository currently depends on `binaryen` `^125.0.0` (`packages/sdk/package.json`, `packages/lib/package.json`).

Research basis:

- Official Binaryen README: [`WebAssembly/binaryen/README.md`](https://github.com/WebAssembly/binaryen/blob/main/README.md)
- Local Binaryen package docs: `node_modules/binaryen/README.md`
- Local Binaryen tool inventory: `node_modules/binaryen/bin/wasm-opt --help`
- Verified default `-O` pipeline via `node_modules/binaryen/bin/wasm-opt /tmp/min.wat -O --debug`

Important confirmed facts:

- `Module#optimize()` runs Binaryen's default optimization passes.
- The Binaryen JS defaults are currently:
  - `optimizeLevel = 2`
  - `shrinkLevel = 1`
- In Binaryen's CLI, `-O` is equivalent to `-Os`.

### Default Binaryen Passes Already Observed In The Pipeline

The default `-O`/`-Os` pipeline already runs the following pass names on a minimal module:

- `duplicate-function-elimination`
- `remove-unused-module-elements`
- `memory-packing`
- `once-reduction`
- `ssa-nomerge`
- `dce`
- `remove-unused-names`
- `remove-unused-brs`
- `optimize-instructions`
- `pick-load-signs`
- `precompute`
- `code-pushing`
- `simplify-locals-nostructure`
- `vacuum`
- `reorder-locals`
- `coalesce-locals`
- `local-cse`
- `simplify-locals`
- `code-folding`
- `merge-blocks`
- `rse`
- `dae-optimizing`
- `inlining-optimizing`
- `duplicate-import-elimination`
- `simplify-globals-optimizing`
- `reorder-globals`
- `directize`

### Binaryen Also Already Provides Additional Optimization Passes

`wasm-opt --help` also exposes many non-default passes that are still clearly Binaryen territory:

- `licm`
- `optimize-added-constants`
- `merge-locals`
- `merge-similar-functions`
- `signature-pruning`
- `signature-refining`
- `global-refining`
- `gto`
- `gufa`
- `heap-store-optimization`
- `heap2local`
- `type-refining`
- `tuple-optimization`

### Implication

Voyd should not duplicate:

- Wasm peepholes
- local/temp cleanup
- generic DCE/CSE/RSE/SSA passes
- low-level inlining
- block merging / CFG cleanup at Binaryen IR granularity
- load/store offset folding
- import/function deduplication
- memory/data-segment packing
- directization of Wasm indirect calls
- GC heap/store optimizations that Binaryen already models directly

If a pass can be expressed purely as a Wasm or Binaryen-IR transform, Binaryen should remain the owner.

## What Voyd Should Optimize Before Codegen

The compiler-owned layer should focus on transformations that need typed, effect-aware, trait-aware Voyd semantics.

### Tier 1: High-value passes to implement first

- Trait dispatch devirtualization
  - Rewrite trait-method calls to direct calls when the concrete impl is known from `ProgramCodegenView`.
  - This is not the same as Binaryen `directize`, which only turns constant table indexes into direct Wasm calls after lowering.

- Effect fast-path elimination
  - Remove effect-handler scaffolding when the callee is statically pure or when the effect row proves an operation cannot occur.
  - Specialize handler lowering for resume-only / tail-resume-only cases.

- Closure environment shrinking
  - Remove uncaptured values from closure environments before any closure struct type is emitted.
  - This reduces generated Wasm GC field counts and helper code, which Binaryen cannot recover once the extra fields exist.

- Continuation / handler environment shrinking
  - Prune captured state from effect trampolines and continuation environments using effect-lowering facts.

- Constructor-known simplification
  - Fold `Option`/union/intersection/tag-style checks when the constructor or exact nominal head is already proven.
  - Example: eliminate branches after inlining overload resolution or monomorphization has made the variant exact.

- Whole-program specialization pruning
  - Drop unreachable monomorphized instances, trait impl wrappers, and helper stubs before Wasm emission.
  - Binaryen can remove unused emitted functions, but it cannot prevent us from generating unnecessary type metadata, helper bodies, or GC shapes in the first place.

- Pure compile-time evaluation
  - Evaluate a tightly controlled set of compiler-known pure intrinsics and annotated library helpers when all inputs are compile-time constants.
  - Keep this at the semantic layer, not as a generic arithmetic peephole pass.

### Tier 2: Good follow-on passes

- Call-shape specialization
  - Specialize resolved calls based on labels/default-argument plans already computed by semantics so codegen emits smaller direct call sequences.

- Redundant runtime type-check elimination
  - Remove casts/tests that are semantically proven by the type arena, trait resolution, or constructor propagation before they become Wasm `ref.test` / `ref.cast`.

- Semantic copy forwarding
  - Forward fields out of freshly constructed aggregates when the aggregate is immediately destructured and does not escape.
  - This should stay narrowly focused on semantic constructs, not devolve into a generic local-value optimizer.

- Addressable wide-local scratch lowering
  - Reuse already-addressable local/out-result storage for wide aggregate construction and mutation when the storage stays within the current lowering region.
  - This is intentionally narrower than future escape-analysis (`V-325`) or scalar-replacement (`V-326`) work: it does not infer reusable whole-program escape facts and it does not split aggregates into scalar locals.

### Explicit non-goals for the compiler pass layer

- Arithmetic peepholes
- local.get/local.set cleanup
- generic inlining heuristics
- loop-invariant code motion
- Wasm CFG cleanup
- stack-machine shaping
- low-level GC heap store optimization

## Proposed Architecture

Add a new compiler package area:

- `packages/compiler/src/optimize/`

Recommended top-level files:

- `packages/compiler/src/optimize/pipeline.ts`
- `packages/compiler/src/optimize/ir.ts`
- `packages/compiler/src/optimize/pass.ts`
- `packages/compiler/src/optimize/analysis/*`
- `packages/compiler/src/optimize/passes/*`

### IR Boundary

Do not run optimization passes directly on Binaryen IR.

Do not run them by mutating typing internals either.

Instead:

1. Keep `ProgramCodegenView` as the stable semantics-owned boundary.
2. Build a compiler-owned `ProgramOptimizationIR` from that view.
3. Run optimization passes on `ProgramOptimizationIR`.
4. Feed optimized function bodies plus optimization facts into codegen.

### `ProgramOptimizationIR`

`ProgramOptimizationIR` should contain only the data that is useful for code generation and optimization:

- reachable `ProgramFunctionInstanceId`s only
- normalized, explicit control-flow expressions
- resolved direct-call targets
- explicit trait-dispatch nodes
- effect rows on expressions/functions
- closure and continuation capture sets
- constructor / nominal-head facts
- exact value type ids

It should not re-expose general binding internals or parser shapes.

### Pass API

Use a small pass manager with explicit analysis invalidation:

```ts
type ProgramOptimizationPass = {
  name: string;
  run(ctx: ProgramOptimizationContext): ProgramOptimizationPassResult;
};

type ProgramOptimizationPassResult = {
  changed: boolean;
  invalidates?: readonly OptimizationAnalysisKey[];
};
```

Analyses should be cached and recomputed on demand:

- call graph
- effect reachability
- escape analysis
- capture analysis
- constructor-known facts
- exact-impl / exact-target facts

### Codegen Integration

In the short term, codegen can consume:

- `ProgramCodegenView` for type/layout metadata
- optimized per-instance bodies from `ProgramOptimizationIR`
- optimization facts that affect lowering decisions

That lets us introduce the optimization layer without rewriting every codegen index at once.

Long-term, function-body codegen should consume optimized IR directly, while the non-body indexes remain semantics-owned via `ProgramCodegenView`.

## Proposed Pipeline Placement

The optimization pass should run in:

- `packages/compiler/src/pipeline-shared.ts`

Specifically:

- in `emitProgram(...)`
- in `emitProgramWithContinuationFallback(...)`
- immediately after `buildProgramCodegenView(...)`
- immediately before `codegen.codegenProgram(...)` / `codegenProgramWithContinuationFallback(...)`

The intended pipeline becomes:

1. `analyzeModules(...)`
2. `monomorphizeProgram(...)`
3. `buildProgramCodegenView(...)`
4. `optimizeProgram(...)`
5. `codegen.codegenProgram(...)`
6. Binaryen `module.optimize()`

This is the right boundary because:

- monomorphization has already exposed whole-program callable instances
- the stable semantics/codegen contract already exists here
- codegen stays focused on Wasm emission
- Binaryen remains the final Wasm optimizer instead of becoming the place where language-level policy lives

## Optimization Policy

Public SDK policy should stay intentionally narrow for now:

- `optimize?: boolean` remains the public SDK switch.
- `optimize: true` should mean the most aggressive validated optimization behavior.
- Less aggressive behavior should be opt-in through compiler-internal or codegen-internal profiles, not through public Binaryen pass configuration in `@voyd-lang/sdk`.

Current aggressive Binaryen policy should include safe non-default passes,
especially heap-focused passes such as `heap-store-optimization` and
`heap2local`.

Current aggressive Binaryen policy should exclude high-risk categories such as:

- passes that require `closed-world` assumptions
- JS-lowering / ABI-legalization passes
- instrumentation passes
- semantic mode-changing passes such as trap-mode rewrites
- unvalidated whole-program GC/type-global refinement passes

In other words, "aggressive" should mean "strongest profile we have validated on
real Voyd output", not "enable every Binaryen flag blindly".

Important rule:

- Voyd compiler passes decide semantic rewrites.
- Binaryen remains the Wasm optimizer, but its exact pass settings should be compiler policy, not a public SDK configuration surface.

That means:

- do not expose raw Binaryen optimize/shrink/pass lists through the SDK yet
- keep the canonical optimization policy in compiler code, not SDK post-processing
- allow a coarse internal profile such as `"standard"` vs `"aggressive"` if the compiler needs it
- keep the reusable Binaryen execution helper in a shared low-level package so compiler and SDK can invoke the same validated pass bundle

## Suggested Implementation Order

1. Add `packages/compiler/src/optimize/pipeline.ts` with a no-op `optimizeProgram(...)`.
2. Call it from both `emitProgram(...)` and `emitProgramWithContinuationFallback(...)`.
3. Introduce `ProgramOptimizationIR` for reachable function instances only.
4. Land `trait dispatch devirtualization`.
5. Land `effect fast-path elimination`.
6. Land `closure/continuation environment shrinking`.
7. Keep Binaryen optimization policy compiler-owned, with aggressive as the default optimized profile.

## Success Criteria

- Language-level optimization decisions happen before Wasm emission.
- Binaryen remains responsible for Wasm/IR cleanup and final optimization.
- Codegen does not need to rediscover semantic facts during lowering.
- New optimizations are testable in compiler/smoke layers without diffing Binaryen internals.
- The compiler generates fewer unnecessary helper functions, dispatch stubs, and GC fields before Binaryen ever runs.
