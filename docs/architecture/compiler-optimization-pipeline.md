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
3. `prepareProgramForCodegen(...)` is the shared normal/fallback preparation
   boundary. It orders lowering inputs and runs the remaining preparation
   phases with common instrumentation.
4. `monomorphizeProgram(...)` builds callable instance metadata, then
   `buildProgramCodegenView(...)` builds the stable codegen-facing semantic
   view.
5. `optimizeProgram(...)` runs for the `balanced` and `release` optimization
   levels.
6. `codegenProgram(...)` receives the optimized program plus optimization facts.
7. Codegen emits a Binaryen module and, when optimized, runs the configured
   Binaryen optimization profile.

The optimization layer is invoked from both public emission paths in
`packages/compiler/src/pipeline-shared.ts`:

- `emitProgram(...)`
- `emitProgramWithContinuationFallback(...)`

Both paths call the same `prepareProgramForCodegen(...)` function and pass its
program and optional published facts into their path-specific codegen entrypoint.

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

## Compiler/Standard-Library Contracts

Optimizer and codegen decisions must use explicit semantic metadata when they
depend on a standard-library role. Source names, module paths, arity guesses,
and structural lookalikes are not contracts: users may define the same names or
shapes, and std implementation details may move without changing their compiler
role.

The supported metadata has four distinct jobs:

- `@compiler_contract(id: "...")` assigns an ordinary std function a stable,
  compiler-owned role. Role IDs use dotted capability names; the current
  catalog is the `voyd.std.boundary.msgpack.*` family in
  `packages/compiler/src/compiler-contracts/function-contracts.ts`. The
  boundary serializer, decoder, value constructors/accessors, array/map
  helpers, and string constructor each have a separate role ID. Optimizer
  reachability and host-boundary codegen resolve those IDs through the program
  symbol arena instead of repeating function names and module paths.
  Synthetic loaders that must place providers in the module graph before this
  metadata exists use the single catalog-owned
  `BOUNDARY_MSGPACK_CONTRACT_PROVIDER_MODULES` bootstrap list; it is never used
  as a codegen identity.
- `@intrinsic_type(type: "...")` supplies nominal type identity for
  compiler-known types. The std identities currently consumed by optimization
  and lowering include `voyd.std.array`, `voyd.std.range`, `voyd.std.string`,
  `voyd.std.string-slice`, `optional-some`, and `optional-none`. A match requires
  both the intrinsic type ID and std
  package ownership, so a user-defined `Array`, `Range`, or structurally similar
  object cannot enter a std-only fast path.
- `@serializer(format, encode, decode)` describes a type's host serialization
  contract. Binding resolves the named functions and boundary lowering checks
  the supported format and payload/signature requirements. It does not by
  itself identify all helper functions used by that format; those dependencies
  use `@compiler_contract` roles.
- `@intrinsic(name: ..., uses_signature: ...)` identifies a function wrapper
  whose implementation is compiler-owned, while `@effect(id: "...")` gives a
  public effect a stable host capability ID. These annotations remain the
  authoritative identities for intrinsic lowering and effect/host protocol
  dispatch; optimizer code must not rediscover either role from source names.

Contract validation is deliberately strict. `@compiler_contract` accepts one
known string ID, is restricted to an ordinary top-level function in the std
namespace, and validates the catalogued arity during binding. Each role also
declares a symbolic typed signature; boundary MsgPack feature use validates the
complete relational ABI after typing, including primitive and shared types,
fixed-array elements, generic/optional parameters, and purity, before emitting
host-boundary calls. Imported aliases do not acquire the contract, duplicate
providers fail when the program symbol arena is built, and a feature that needs
a missing or incompatible role fails with a diagnostic instead of silently
selecting a name-based fallback. Attribute syntax rejects duplicate attributes,
invalid targets, unknown labels, and invalid value types.
The owning binder or lowering stage performs the additional semantic validation
specific to `@serializer`, `@intrinsic_type`, `@intrinsic`, and `@effect`.

Changing a contract ID, its meaning, or its required signature is a compiler/std
compatibility change. Renaming or moving the annotated implementation is not,
provided its metadata and semantics remain valid.

## Core Files

- `packages/compiler/src/optimize/ir.ts`
  - defines `ProgramOptimizationIR`, `ProgramOptimizationFacts`, and
    `ProgramOptimizationResult`
- `packages/compiler/src/optimize/pass.ts`
  - defines the pass interface, key-to-result analysis map, and explicit
    mutation categories
- `packages/compiler/src/optimize/state.ts`
  - constructs and owns the optimizer-private mutable IR
- `packages/compiler/src/optimize/program-index.ts`
  - indexes immutable symbols/imports and revisioned HIR body topology
- `packages/compiler/src/optimize/runner.ts`
  - executes passes, records telemetry, applies invalidation, and enforces
    fixed-point convergence
- `packages/compiler/src/optimize/schedule.ts`
  - defines the ordered initial, fixed-point, and final-analysis phases
- `packages/compiler/src/optimize/context.ts`
  - owns typed analysis caching and automatically connects categorized
    mutations to analysis and body-index revision invalidation
- `packages/compiler/src/optimize/finalize.ts`
  - rebuilds derived effect data and assembles the optimized program
- `packages/compiler/src/optimize/publish-facts.ts`
  - owns the isolated mutable-to-immutable fact publication snapshot
- `packages/compiler/src/optimize/pipeline.ts`
  - registers pass modules, executes the schedule, and finalizes the result
- `packages/compiler/src/optimize/passes/*`
  - focused owners for constant/control simplification, reachability, receiver
    and trait propagation, capture shrinking, escape analysis, runtime facts,
    and call-shape planning
- `packages/compiler/src/optimize/codegen-plan.ts`
  - contains longer-lived codegen planning data
- `packages/compiler/src/compiler-contracts/*`
  - defines stable function-role and std nominal-type identities shared by
    semantics, optimization, and codegen
- `packages/compiler/src/optimization-policy.ts`
  - resolves public optimization levels and the frozen specialization limits
- `packages/compiler/src/codegen/specialization-policy.ts`
  - composes specialization identities and owns program-wide admission
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
analysis mechanism. The shared runner owns pass telemetry and applies declared
invalidations before the next pass runs. HIR-topology invalidation also advances
the revisioned body index so removed branches and rewritten calls cannot remain
in cached traversals.

Current cached analysis keys are:

- `reachable-function-instances`
- `handler-captures`
- `trait-dispatch-signatures`
- `hir-body-topology`

## Indexed Analyses And Worklists

`ProgramOptimizationIndex` is built once per optimizer invocation. Immutable
module structure is indexed by module and symbol for functions, module lets,
imports, names/arities, and compiler intrinsics. Function and default-parameter
roots share a lazy body-topology cache across generic instances; only expression
IDs and call-site IDs are cached, never caller-specific targets or type args.

Structural HIR rewrites invalidate the affected topology revision. The hot
whole-program analyses then use those indexes:

- exact/known receiver discovery and validation share one indexed call-site view
  instead of rediscovering each generic body on every fixed-point round
- reachability uses set-backed instance/module-let queues and an indexed trait
  signature-to-instance closure instead of linear queue checks and rescans
- trait-parameter reachability is memoized per instance/parameter
- parameter escape propagation uses a reverse-caller worklist and reprocesses
  only callers of a function whose escape facts grew

Scorecard counters under `optimize.index.*` and the pass-specific `worklist_*`
counters expose cache construction, reuse, and queue work.

## Current Pass Schedule

The schedule is convergence-driven rather than a fixed number of duplicated
slots:

1. Initial simplification runs compile-time evaluation, boolean simplification,
   constructor simplification, and effect fast-path elimination.
2. Reachability pruning, exact receiver propagation, constructor
   simplification, trait devirtualization, compile-time evaluation, boolean
   simplification, and effect elimination repeat until an entire iteration is
   unchanged. A program-size-derived safety budget accommodates deep valid
   chains while still failing loudly on genuine non-convergence instead of
   accepting a partially optimized program.
3. Closure and handler capture shrinking run after HIR convergence, followed by
   runtime-check facts, copy-forwarding facts, and escape analysis.

Computing capture facts after convergence is important: an eliminated match arm
or branch must not leave dead fields in a handler environment.

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

### Centralized Specialization Policy And Admission

Specialization limits are resolved once for a compilation and carried in
`ProgramCodegenOptimizationPlan.specializationPolicy`. The policy object is
frozen and shared by optimizer planning and codegen, so receiver propagation,
direct trait switches, scalar-aggregate calls, static-effect, and call-shape
specializations cannot drift onto independent thresholds during one build.
Codegen without optimizer facts resolves the same policy from the selected
optimization level.

There is a hard separation between semantic safety and tuning:

- Owning passes and lowering sites decide whether a specialization preserves
  types, effects, object identity, capture behavior, ABI boundaries, and
  evaluation order. Those checks are invariants and cannot be enabled or
  weakened by a budget.
- `SpecializationPolicy` only limits work that has already passed those checks.
  Its tunables cap receiver contexts and exact receiver parameters, direct
  trait-switch implementations, scalar aggregate lanes and call contexts,
  static-effect contexts, call-shape contexts, total contexts per base
  function, total contexts per program, and the total estimated duplicated HIR
  body nodes.

Every body-duplicating codegen specialization is admitted through one
program-scoped ledger. Before codegen, the program plan freezes deterministic
per-kind reservations that partition the shared per-function, per-program, and
estimated-body-node totals. Admission first applies the specialization-kind
cap, then that kind's reservation. Receiver, scalar-aggregate, static-effect,
and call-shape requests therefore cannot consume one another's capacity based
on codegen encounter order. Within each kind, owning planners/traversals provide
stable candidate order and identities. Rejected requests use the existing
unspecialized lowering; they do not change program semantics. The body-node
estimate is cached per base function so admission cost does not require
repeated HIR walks.

The deterministic external ray comparison for the original optimizer rollout
showed byte-identical output and effectively flat runtime with approximately
1.2% optimized-Wasm growth. That growth is an accepted current policy tradeoff:
specializations remain bounded by the program-wide context and
estimated-body-node limits, and the planned/admitted/rejected counters below
make future size tuning attributable instead of implicit.

The rollout evidence attributes the growth to duplicated specialization bodies,
with call-shape specialization the primary newly introduced source rather than
a runtime/data-layout change. Normalizing the external result, optimized Wasm
moved from `100.0` to approximately `101.2` while output bytes stayed identical.
The focused call-shape scorecard selected 5 calls across 4 shapes, emitted 4
reusable clones, removed 3 parameters, and eliminated 2 default branches. Those
extra function bodies explain the direction of the size delta; the flat runtime
shows that this workload did not recover the bytes as a measured speedup. The
raw external-ray byte counts were not retained in this repository, so the 1.2%
figure is the authoritative recorded delta rather than reconstructed numbers.
The policy currently accepts it because fallback semantics are unchanged and
the clone cost is now explicitly bounded and visible. Frozen per-kind
reservations prevent unrelated specializations from amplifying that cost based
on encounter order, and the emitted-function/admission counters are the gate for
future reductions.

A specialization identity is compositional rather than a suffix owned by one
feature. Its dimensions include exact receiver parameter types,
scalar-aggregate parameter/result layout, static-effect identity, and
call-shape identity. Adding a dimension preserves the existing dimensions on
the function metadata. This prevents, for example, a
scalar-aggregate specialization of two receiver variants from colliding or
silently reusing the wrong body.

With `VOYD_COMPILER_PERF=1`, admission emits:

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

The current `<kind>` values are `receiver`, `scalar_aggregate`,
`static_effect`, and `call_shape`. As with other compiler perf
counters, an absent counter means zero.

### Call-Shape Specialization

The final optimizer schedule records reusable argument-presence shapes after
reachability and trait devirtualization have converged. A request is keyed by
the call site, exact caller instance, concrete callee instance, and a compact
per-parameter state: `provided`, `omitted`, or `stable-callsite-id`. Labels,
source argument indexes, structural field names, and stable-ID values remain in
the authoritative call-lowering metadata; they are deliberately not copied
into the shape identity.

Planning and admission are intentionally separate typed stages. The optimizer
publishes deterministic `stage: "planned"` requests with stable identities and
owns the per-callee call-shape planning cap. The frozen program plan owns budget
reservations; codegen owns admission within each reservation. Planner telemetry
reports `planned_calls`; codegen reports requested, admitted, reused, and
rejected outcomes. This split makes the size tradeoff explicit without allowing
codegen encounter order to move capacity between specialization kinds or change
which call shapes the optimizer selects.

## Mutation And Structure Contracts

Passes publish mutations through five category-specific
`ProgramOptimizationContext` methods: HIR topology, call resolution,
reachability/instances, captures, and produced facts. Each callback receives a
narrow facade that exposes only its category's operations; mutable optimizer IR
is not available to passes. The query view is deeply readonly, and optimizer-
owned HIR nodes are recursively frozen at runtime; even an unsafe consumer cast
cannot mutate nested topology behind the facade. A topology callback must name its affected modules,
which advances body-index revisions and invalidates all analyses derived from
traversal. Analysis keys are statically mapped to result types; callers cannot
retrieve one key as an unrelated result type.

Module items, function signatures, imports, and symbol metadata are immutable
during optimization. Module items, metadata, and function signatures are frozen
when optimizer state is built. `ProgramOptimizationIndex` fingerprints every
indexed structural input at construction and verifies the snapshot before
finalization. Structural transforms must therefore introduce an explicit
index-rebuild contract before they can be added; a cast cannot silently leave
stale roots or symbol/import indexes. Keeping the invariant structural avoids a
full-program fingerprint scan after every ordinary expression pass.

Codegen turns an admitted request into a private callee clone while preserving
the original ABI for exports, closures, indirect calls, dynamic trait
dispatch, and fallback calls:

- supplied ordinary parameters retain their existing ABI
- supplied defaulted parameters pass their declared type directly, including
  ordinary mutable- and immutable-reference ABI lowering
- omitted defaulted parameters have no ABI lanes and evaluate their HIR
  default in declaration order inside the clone
- omitted plain optional parameters have no ABI lanes and construct `None`
  inside the clone
- stable callsite IDs pass one raw `i32`, so different callsites share a clone
  while retaining distinct values

Labeled argument reordering and structural-container field extraction stay in
the caller. This preserves source evaluation order, exactly-once container
evaluation, and mutable/addressable field behavior. The clone only removes
the stable presence lane and corresponding callee presence/default branch. Generic
instances, imports, methods after devirtualization, wide values, receiver
variants, scalar aggregate variants, and static-effect variants use the same
compositional specialization metadata.

The planner ranks shapes for each concrete callee by reachable callsite count
with a deterministic key tie-break, then applies
`callShapeContextsPerFunction`. Codegen still admits each clone through the
shared per-function, per-program, and duplicated-body-node ledger. Body-size
accounting includes default-expression roots. Rejection at either stage uses
the original call path.

Default omission is first-class in the semantic call plan. `omitted-default`
is distinct from `omitted-optional`: the former evaluates declaration metadata
to produce the declared parameter type, while the latter constructs the
source-level `None` value for an `Optional<T>` parameter. This distinction is
preserved through `ProgramCodegenView`; codegen does not inspect typing
internals.

Stable-signature paths encode each defaulted parameter as its ordinary payload
or storage-reference lanes plus an internal `i32` presence lane. The lane is
not part of the source type. A supplied reference transports the caller's
storage reference. For an omitted reference, the payload is ignored and the
callee's default prologue evaluates the expression into fresh addressable
storage, then binds the parameter to that storage for the invocation. Value
defaults use the same presence protocol and prologue, so optimized and
fallback paths share evaluation order and exactly-once behavior.

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

| Scenario                                      | Runtime ms base -> head | Runtime delta | Compile ms delta | Wasm bytes delta | WAT bytes delta | `struct.new` delta | `tuple.make` delta |
| --------------------------------------------- | ----------------------: | ------------: | ---------------: | ---------------: | --------------: | -----------------: | -----------------: |
| focused/non-escaping-object-local             |          0.082 -> 0.067 |        -18.3% |            +5.3% |            -0.3% |           -0.2% |                 -3 |                  0 |
| focused/mutable-object-temporary              |          0.104 -> 0.053 |        -49.0% |           +17.7% |            -0.3% |           -0.2% |                 -3 |                  0 |
| focused/direct-value-call-argument            |          0.057 -> 0.049 |        -14.0% |            +7.8% |            -0.3% |           -0.2% |                 -3 |                  0 |
| focused/direct-heap-call-argument             |          0.060 -> 0.047 |        -21.7% |           +18.4% |            -0.3% |           -0.2% |                 -3 |                  0 |
| focused/direct-heap-call-literal              |          0.046 -> 0.050 |         +8.7% |            +4.7% |            -0.3% |           -0.2% |                 -3 |                  0 |
| focused/direct-heap-call-return               |          0.054 -> 0.047 |        -13.0% |            -0.0% |            -0.3% |           -0.2% |                 -3 |                  0 |
| focused/escape-boundary-rematerialization     |          0.047 -> 0.047 |          0.0% |            +2.0% |            -0.3% |           -0.2% |                 -3 |                  0 |
| representative/scalar-aggregate-particle-step |          0.547 -> 0.033 |        -94.0% |            +0.4% |            -1.9% |           -1.3% |                 -4 |                  0 |
| representative/vtrace-compute-main            |      271.129 -> 264.969 |         -2.3% |            +6.1% |            +0.9% |           +1.5% |                +11 |                 +4 |

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

After Voyd codegen emits the Binaryen module, enabled optimization levels run
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

Public policy maps `balanced` to the standard Binaryen profile and `release` to
the aggressive profile; `none` skips both the semantic optimizer and Binaryen.
The legacy `optimize: true` switch maps to `release`, while direct compiler
clients using `optimize: true` with `optimizationProfile: "standard"` continue
to map to `balanced`. Explicit `optimizationLevel` takes precedence.

Raw pass selection is not public API. The scorecard can run guarded internal
ablation workers that omit one aggressive pass or the final optimization cycle;
normal workers clear those environment settings to keep baselines isolated.

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
- `tests/conformance` and `tests/integration`
  - end-to-end public behavior and realistic integration checks
- benchmark scripts
  - performance/code-size decisions for optimizations whose value is uncertain

The canonical cross-pass benchmark and regression format is the optimizer
scorecard documented in `docs/compiler-performance.md` and implemented by
`scripts/bench-optimizer.ts`. Use its quick or CI preset for optimizer changes;
the scheduled full preset covers the realistic vtrace and effect/wide-value
cases. Ticket-specific benchmark scripts are historical reproduction tools, not
the ongoing regression gate.

Selected public smoke behavior is compiled and executed at `none`, `balanced`,
and `release` by `tests/integration/src/optimization-differential.test.ts`. Keep that
fixture batched so end-to-end protection does not multiply the std/compiler
setup cost.

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
