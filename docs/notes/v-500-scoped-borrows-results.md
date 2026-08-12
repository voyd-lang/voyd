# V-500 scoped explicit borrows: performance results

Status: **static optimization-consumer inventory complete; acceptance
measurements pending**.

This note is the required performance-report home for V-500. It separates
compiler state-growth evidence from runtime optimization evidence. Do not mark
V-500 performance complete until every required workload and every accepted
optimization consumer has a measured disposition below.

## Result status

No acceptance result is recorded in this checked-in scaffold. Running a
single-sample smoke command validates the runner and generated Voyd syntax; it
does not establish a performance conclusion. Replace `Pending` cells only with
same-machine base/head measurements made from clean, identified revisions.

| Evidence set                           | Status                                                | Result artifact |
| -------------------------------------- | ----------------------------------------------------- | --------------- |
| Generated ordinary DTO scaling         | Pending                                               | —               |
| Generated explicit `Borrow<T>` scaling | Pending                                               | —               |
| Generated mutation-shape scaling       | Pending                                               | —               |
| Full `pkg::web` cold compile           | Pending                                               | —               |
| Representative full-stack application  | Pending                                               | —               |
| Warm source-only SDK edit              | Pending; `bench:v500 --warm-source-edit` is available | —               |
| Historical V-499 controls              | Pending                                               | —               |
| Accepted optimization suite            | Pending                                               | —               |

## Generated benchmark command

The V-500 runner generates one canonical scenario in the controlling checkout
and loads each measured checkout's SDK by absolute path. The canonical spelling
is `Borrow<T>`. For the V-500 base revision, the runner renders only that type
spelling as legacy `borrow T`; all declarations, expressions, call topology,
expected values, and source-only edits stay unchanged. The generated Borrow
workloads deliberately use the semantic intersection of both models: scoped
callable inputs and `SharedCell` callbacks, with no borrowed results, containers,
regions, or contracts.

The dialect is detected independently for each checkout from the compiler's
borrowed-type display implementation, and detection fails closed if exactly one
known spelling is not present. This allows the current runner to compare a base
checkout that does not contain the runner itself. Dependencies must already be
installed in both checkouts.

```sh
npm run bench:v500 -- \
  --repo base=/absolute/path/to/base \
  --repo head=/absolute/path/to/head \
  --sizes 4,8,16,32 \
  --modes none,release \
  --samples 7 \
  --warmups 1 \
  --runtime-samples 9 \
  --runtime-min-ms 100 \
  --fail-on-diagnostics \
  --output /tmp/v500-generated.json
```

Useful discovery and focused-validation commands are:

```sh
npm run bench:v500 -- --help
npm run bench:v500 -- --list --sizes 4,8,16,32
npm run bench:v500 -- --list-workloads
npm run bench:v500 -- \
  --scenario ordinary-fields-4 \
  --modes none \
  --samples 1 \
  --warmups 0 \
  --fail-on-diagnostics
```

The first `--repo` is the ratio baseline. Each compile uses a fresh Node
process with `compilerCache: "none"` and `VOYD_COMPILER_PERF=1`. Repository
order alternates for measured samples. Runtime groups, when requested, run on
the last release artifact after one untimed host call.

For a warm source-only edit, add `--warm-source-edit`. Each fresh worker then
creates one memory-cached SDK, primes it with the generated source, appends one
comment while retaining the entry path, and times the second compile. The JSON
keeps the priming distribution and both source hashes separate from the timed
edit distribution.

The JSON report retains:

- every wall-time, heap, RSS, diagnostic, runtime, phase, and counter sample;
- min, median, p95, and max distributions;
- canonical semantic-source hashes, per-dialect rendered-source hashes,
  replacement counts, compiler dialect evidence hashes, revisions,
  dirty-worktree state, hardware, and Node version;
- required metric aliases while retaining all raw compiler telemetry;
- cold versus warm-edit methodology and priming distributions;
- adjacent growth ratios across the complete generated series; and
- same-machine candidate/base ratios for timings, memory, Wasm size, phases,
  counters, and required metrics.

Report schema version 3 records the detected dialect on every repository and
result row. `sourceManifest` groups the canonical hash with every rendered hash,
while warm-edit rows keep canonical and rendered hashes for both priming and
timed sources. Mixed-dialect comparisons therefore remain auditable without
claiming byte-identical input text.

If a required compiler counter is absent, the JSON value is `null` and the
metric appears in `missingRequiredMetrics`. Missing telemetry is a pending
instrumentation item, not a zero.

`borrowing.explicitBorrowFacts` and
`analyzeBorrowing.explicitBorrow` are deliberately observable as exact zeroes
for modules without `Borrow<T>`. For Borrow-aware modules, the counter is the
number of parameter-level `Borrow<T>` facts and the phase records the measured
explicit analysis duration.

## Methodology to record with final results

Fill this table from the generated JSON and the companion workload artifacts.

| Item                                       | Measured value |
| ------------------------------------------ | -------------- |
| Base revision and dirty state              | Pending        |
| Head revision and dirty state              | Pending        |
| Machine, OS, CPU, logical CPUs, RAM        | Pending        |
| Node and npm versions                      | Pending        |
| Power/thermal policy                       | Pending        |
| Exact commands                             | Pending        |
| Compile samples per point                  | Pending        |
| Discarded compile warmups per point        | Pending        |
| Runtime samples and minimum group duration | Pending        |
| Compiler cache mode                        | Pending        |
| Compile kind and source-only edit policy   | Pending        |
| Raw JSON artifact locations and hashes     | Pending        |

## ADR acceptance workload plan

`npm run bench:v500 -- --list-workloads` emits the machine-readable form of
this plan, including the required evidence for each row. `Ready` means a runner
exists; every measurement remains pending until a same-machine base/head run is
recorded.

| ADR workload                                                                                          | Owner and command                                                                                                                     | Harness coverage                                                                    | Measurement status |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------ |
| Provider-neutral generic DTO graph at four or more independent sizes                                  | `bench:v500`, `ordinary-fields` and `ordinary-topology`                                                                               | Ready                                                                               | Pending            |
| Explicit Borrow calls, projection depth, and nested scoped callbacks                                  | `bench:v500`, `borrow-calls`, `borrow-depth`, and `borrow-callbacks`                                                                  | Ready                                                                               | Pending            |
| Direct, dynamic, callback, ambient, identity-guard, and SCC mutation shapes                           | `bench:v500`, `mutation-mixed`                                                                                                        | Ready                                                                               | Pending            |
| Full `pkg::web` cold compile                                                                          | `bench:web-openapi` with clean base/head checkouts, `--warmups 1 --samples 7` and native JSON output                                  | Ready                                                                               | Pending            |
| Representative full-stack application                                                                 | `npm run bench:v439 -- --scenario representative-web-app-request --samples 7 --runtime-samples 31 --output /tmp/v500-full-stack.json` | Ready                                                                               | Pending            |
| Warm source-only edit through one SDK                                                                 | `bench:v500 --warm-source-edit`                                                                                                       | Ready                                                                               | Pending            |
| Historical V-499 selected-provider and host-boundary-disabled compiles                                | Focused export-ABI control and `bench:optimizer`                                                                                      | Selected-provider control emits one sample per invocation; retain repeated raw runs | Pending            |
| Stable-field, mutable-result, counted-array, Range, intrinsic Array, and exact-iterator optimizations | `bench:v439`, `bench:mutable-result`, `bench:array-for`, and `bench:iterator-for` plus focused shape tests                            | Ready; Range has isolated direct and Array-derived entrypoints                      | Pending            |
| Deferred-default identity-guard companion                                                             | `bench:v439 --scenario deferred-default-identity-guard`                                                                               | Ready; compiles a demanded companion and retains its nonzero disposition counters   | Pending            |

Run base and head in one invocation. Do not combine numbers from different
machines or hide a regression with different timeouts, worker counts, batching,
or compiler branches. Timing ratios support the result, while counter and
state-growth gates are authoritative across machines.

## Generated workload matrix

The runner creates every point independently; larger sources are not produced
by importing or reusing compiled smaller points.

| Family              | Independent variable         | Fixed or co-varying shape                                                                                                                                      | Required conclusion                                                                                                      | Status  |
| ------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------- |
| `ordinary-fields`   | DTO field count              | One generic nested DTO, variant, trait call, projected mutation                                                                                                | Field growth does not grow interprocedural summary bytes; explicit facts, projection families, and widenings remain zero | Pending |
| `ordinary-topology` | Repeated DTO/call topology   | Four fields per DTO; generic nested records, variants, traits, projected mutation                                                                              | Summary state and evaluations grow no faster than the affected call graph                                                | Pending |
| `borrow-calls`      | Borrow-aware callable chain  | Projection depth and callback nesting fixed                                                                                                                    | Explicit facts track Borrow-aware call growth                                                                            | Pending |
| `borrow-depth`      | Local projection depth       | Borrow-aware callable and scoped callback count fixed                                                                                                          | Field-sensitive facts stay local and parameter-level boundary state remains bounded                                      | Pending |
| `borrow-callbacks`  | Nested scoped callback count | One scalarized read per callback; outer callbacks capture only ordinary scalars                                                                                | Nested scope cost and fact growth remain bounded                                                                         | Pending |
| `mutation-mixed`    | Repeated topology            | Direct chains, dynamic trait calls, callback calls, ambient closure reads, identity-guard sites, and recursive SCC members are reported as separate dimensions | Finite ordinary summaries converge with bounded reevaluation and no projection/widening state                            | Pending |

Use all four or more points when drawing a scaling conclusion. Two endpoints
are insufficient. The default points are `4,8,16,32`.

## Structural acceptance gates

Record raw values at every size before assigning a result.

| Gate                                                                          | Evidence                                                 |    Base |    Head | Result  |
| ----------------------------------------------------------------------------- | -------------------------------------------------------- | ------: | ------: | ------- |
| Increasing ordinary DTO fields does not increase interprocedural summary size | `ordinary-fields` / `retainedSummaryBytes`               | Pending | Pending | Pending |
| Ordinary mutation creates no projection families                              | Ordinary series / `projectionFamilyCount`                | Pending | Pending | Pending |
| Ordinary mutation creates no widenings                                        | Ordinary series / `wideningCount`                        | Pending | Pending | Pending |
| A no-`Borrow<T>` program creates zero explicit provenance facts               | Ordinary and mutation series / `explicitBorrowFactCount` | Pending | Pending | Pending |
| Summary evaluations stay close to affected call-edge growth                   | `ordinary-topology` adjacent ratios                      | Pending | Pending | Pending |
| Doubling repeated topology does not create superlinear summary-state growth   | `ordinary-topology` adjacent ratios                      | Pending | Pending | Pending |
| Selected-provider ordinary functions bypass detailed borrow analysis          | V-499 selected-provider control counters                 | Pending | Pending | Pending |
| Exact-call analysis stays within work and memory budgets                      | Optimizer disposition counters                           | Pending | Pending | Pending |
| No accepted optimization silently disappears                                  | Consumer matrix and optimized shape/runtime results      | Pending | Pending | Pending |

The benchmark emits exact zero/constant observations where telemetry is
available. Thresholded judgments such as “close to call-edge growth” must cite
the complete point series and the chosen threshold here.

## Full-stack and historical controls

These companion commands cover workloads that should stay in their existing
owners instead of being duplicated in the generated-source runner.

Cold `pkg::web` package compile:

```sh
npm run bench:web-openapi -- \
  --repo base=/absolute/path/to/base \
  --repo head=/absolute/path/to/head \
  --compiler-cache none \
  --compile-count 1 \
  --warmups 1 \
  --samples 7 \
  --require-clean \
  --output /tmp/v500-web-openapi-base-head.json
```

Warm source-only edit through one SDK instance:

```sh
npm run bench:v500 -- \
  --repo base=/absolute/path/to/base \
  --repo head=/absolute/path/to/head \
  --scenario ordinary-topology-16 \
  --modes none \
  --samples 7 \
  --warmups 1 \
  --warm-source-edit \
  --output /tmp/v500-warm-edit.json
```

The priming compile is recorded separately and is not included in the timed
edit distribution. Peak-process memory still reflects the worker that owns
both compiles; `processMaxRssGrowthBytes` uses the post-prime maximum as its
baseline.

Historical selected-provider compile:

```sh
VOYD_COMPILER_PERF=1 npx vitest run \
  --config vitest.config.ts \
  --testTimeout 120000 \
  --hookTimeout 120000 \
  packages/compiler/src/codegen/__tests__/export-abi.test.ts \
  -t 'avoids wrapper export name collisions with user exports' \
  --reporter=dot \
  --disableConsoleIntercept
```

Run it repeatedly in alternating base/head order and retain each raw compiler
summary. The focused historical control does not aggregate distributions.

Host-boundary-disabled compile:

```sh
npm run bench:optimizer -- \
  --preset full \
  --scenarios vtrace-main \
  --modes unoptimized \
  --compile-warmups 1 \
  --compile-samples 7 \
  --runtime-samples 9 \
  --output /tmp/v500-v499-host-boundary-off.json
```

Historical V-499 host runtime gates remain an additional regression control:

```sh
VOYD_RUN_PERF_SMOKE=1 npx vitest run \
  --config vitest.config.ts \
  --testTimeout 300000 \
  --hookTimeout 120000 \
  tests/performance/src/v499-boundary-gates.test.ts
```

Record the full-stack application entry, command, checksum, compile
distribution, runtime distribution, peak RSS, and Wasm bytes here. The existing
`tests/performance/fixtures/web-app-request-pipeline.voyd` scenario in
`bench:v439` is the current representative candidate; confirm that ownership
before using it as the final V-500 full-stack result.

Isolated Range and deferred-default companion artifacts:

```sh
npm run bench:v439 -- \
  --scenario isolated-range-optimizations \
  --samples 7 \
  --runtime-samples 31 \
  --output /tmp/v500-range-optimizations.json

npm run bench:v439 -- \
  --scenario deferred-default-identity-guard \
  --samples 7 \
  --runtime-samples 31 \
  --output /tmp/v500-deferred-default-guard.json
```

Both reports retain raw compile/runtime samples, compiler phase and counter
summaries, operating-system peak RSS, Wasm hashes and sizes, and whole-module
and per-export WAT shape counts. The Range artifact has separate direct Range
and Range-derived Array runtime distributions. The guard artifact records the
nonzero deferred guard plus requested/created/compiled companion counters and
the final identity comparison/panic path. The focused compiler test owns the
pre-Binaryen `__default_identity_guard_v1` name assertion because Binaryen may
inline the demanded companion.

## Standard-library API migrations

V-500 deliberately removes callback-heavy mutation APIs that cannot satisfy
the finite ordinary-mutation rules. An unknown callback cannot run while an
exclusive `~T` input is active because it may re-enter through an ordinary
alias. The implementation makes these migrations without a compatibility
layer:

| Removed API | Supported replacement | Behavior coverage |
| --- | --- | --- |
| `Array.sort(~self, compare)` and `Array.sort(~self, by: compare)` | Use `Array.sorted(compare)` or `Array.sorted(by: compare)`, which returns an independently owned sorted Array. The built-in `Array.sort(~self)` remains for the closed default comparison. | `array.test.voyd` covers both comparator-returning overloads, source isolation, and the default in-place sort. |
| `Array.zip(self, other: Sequence<U>)` | Materialize the other input as an `Array<U>` and use `Array.zip(self, other: Array<U>)`. | `array.test.voyd` covers the retained Array overload. |
| `Array.extend(~self, items: Sequence<T>)` | Iterate before entering the exclusive mutation or materialize an `Array<T>` and use `Array.extend(~self, other: Array<T>)`. | Array tests cover direct extension and the persistent `extended` form. |
| `Dict.extend(~self, entries: Sequence<(K, V)>)` | Build a `Dict<K, V>` before the exclusive call and use `Dict.extend(~self, other: Dict<K, V>)`. | `dict.test.voyd` covers count and replacement semantics for the retained Dict overload. |
| `Collect.from_sequence(items: Sequence<T>)` | Transfer an owned iterator through `Collect.from_iterator(~items: Iterator<T>)`. | `traits/contracts.test.voyd` checks the retained trait contract and a concrete implementation. |

These are source-level breaking changes required by the scoped model. They do
not alter the unaffected Array/Dict operations or ordinary iterator behavior.

## Optimization consumer disposition

Every consumer of a removed borrowing contract must select exactly one owner:
finite ordinary summary, explicit-Borrow checking, bounded exact-call fact, or
deletion. Copy a row for each concrete compiler consumer; do not group consumers
that have different proofs or fallbacks.

The V-500 base-tree audit found exactly three optimizer consumers of the legacy
`CallableAccessIndex`: stable-field forwarding, mutable scalar-aggregate lane
ABI selection, and the shared safe-array-loop call predicate. The direct
`Range` lowering, intrinsic `Array` iteration, and exact iterator
specialization did not read a borrowing contract. They remain in the ledger
because the ADR names them as required acceptance controls.

The audit also found three codegen consumers of the legacy
`callableRuntimeProtocols` view and one consumer of the protocol copied onto
each deferred guard. The table separates guard planning/lowering from eager
companion publication because they have different dispositions and fallbacks.
No optimizer consumer moved to explicit-`Borrow<T>` checking.

### Static migration inventory

| Consumer and source location                                                                                                                                                                        | Prior contract fact                                                                                                                                                         | New owner                                            | Exact proof and bound                                                                                                                                                                                                                                                                                                                                                                                          | Conservative fallback                                                                                                                                                                |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Legacy codegen footprint adapter: base `semantics/codegen-view/index.ts`, `CallableAccessIndex.getFootprint`; replacement `OrdinaryMutationIndex` and `ExactCallOptimizationIndex` in the same file | Projected `readPaths`/`writePaths`, runtime-checked writes, retention, returned/result provenance, external read/write, and suspension copied from `CallableBorrowContract` | Deletion                                             | The compatibility adapter is gone. Consumers request either the four-field ordinary summary or a demand-driven exact-body fact; no coarse-summary-to-precise-contract reconstruction exists.                                                                                                                                                                                                                   | A missing selected fact is `undefined`/`fallback`, so each consumer declines its transformation.                                                                                     |
| Stable-field call disjointness: `optimize/passes/stable-field-loads.ts`, `callIsDisjoint`                                                                                                           | Callee field `writePaths`, `runtimeCheckedWrites`, external access, suspension, and call argument mapping                                                                   | Bounded exact-call fact                              | For each resolved exact target, require a safe boundary; no whole-value or indirect access; no escape, retention, or result alias; and no write to the candidate field. Each fact scan has 4,096 work units, a 64 KiB fact limit, and shares a 1 MiB cache limit.                                                                                                                                              | Reject the forwarding candidate and emit the ordinary repeated field loads. Dynamic dispatch, guards, unresolved targets, unsupported aliases, or budget failure all take this path. |
| Stable-field escape barrier: `optimize/passes/stable-field-loads.ts`, `callHasNoEscape`                                                                                                             | Callee parameter `retained`, `returned`, and returned-provenance flags plus external access and suspension                                                                  | Bounded exact-call fact                              | Every resolved target must have the same budgeted safe-boundary fact and prove `escapes = false`, `retained = false`, and `resultAliases = false` for every parameter.                                                                                                                                                                                                                                         | Reject the forwarding candidate and emit ordinary field loads when any target is missing, opaque, nested, dynamic, retaining, escaping, result-aliasing, or over budget.             |
| Fresh mutable aggregate lane ABI: `codegen/optimization/mutable-scalar-aggregate-calls.ts`, `mutableScalarAggregateCalleeCanUseLaneAbi`                                                             | Direct field read/write paths, no runtime-checked writes, no retention or returned provenance, no external access or suspension, plus a second HIR direct-field walk        | Bounded exact-call fact                              | The same 4,096-work/64-KiB-fact/1-MiB-cache limits apply. The callee must be exact, pure, direct-result ABI, mutable-reference ABI, direct-field-only, non-escaping, non-retaining, non-result-aliasing, and free of nested, recursive, dynamic, unresolved, external, suspended, or guarded boundaries. At least one field write is required.                                                                 | Use the ordinary call ABI and materialize the aggregate; no mutable lane companion is reserved.                                                                                      |
| Counted `while` Array checked-access elision: `codegen/optimization/array-fast-paths.ts`, `safeLoopResolvedCallDecision` via `bodyPreservesArrayLoopProof`                                          | Full callee footprint: no parameter writes, runtime-checked writes, retention, returned provenance, external read/write, or suspension                                      | Finite ordinary summary                              | Each resolved helper requires all parameter modes to be `unused`/`read` and all three bits (`ambientObjectAccess`, `invokesUnknownCallback`, `maySuspend`) to be false. The call cannot receive the iterated Array alias. The interprocedural fact has one three-state slot per parameter plus three monotone bits, retains `6 + parameterCount` bytes, and its SCC worklist requeues only affected callers.   | Keep checked `Array.at`/`Array.get` lowering, or decline the safe counted-loop transformation when its structural loop proof also fails.                                             |
| Direct intrinsic `Range<i32>` loop: `codegen/optimization/array-fast-paths.ts`, `tryAnalyzeRangeForLoop`/`compileRangeForLoop`                                                                      | None; verified non-consumer                                                                                                                                                 | Existing bounded code-local proof                    | Canonical intrinsic `Range<i32>`, literal inclusive/half-open mode, exact macro shape, and effect-free caller are checked in the current body. No interprocedural provenance or borrowing fact is retained.                                                                                                                                                                                                    | Compile the original iterator loop and dynamic/general dispatch.                                                                                                                     |
| `Range`-derived Array checked-access elision: `codegen/optimization/array-fast-paths.ts`, `tryAnalyzeRangeForLoop.safeArrayScope` via `bodyPreservesArrayLoopProof`                                 | The same legacy callee footprint used by counted `while` loops                                                                                                              | Finite ordinary summary                              | A `0..<array.len()` Range may open the safe Array scope only when the loop body passes the same finite-summary helper-call test above. The direct Range counted loop has an independent proof and does not depend on this result.                                                                                                                                                                              | Retain the direct Range loop but keep checks/dispatch on Array accesses inside it; if the Range shape itself is not exact, use the original iterator loop.                           |
| Intrinsic `Array<T>` `for` lowering: `codegen/optimization/array-fast-paths.ts`, `tryAnalyzeArrayForLoop`/`compileArrayForLoop`                                                                     | None; verified non-consumer                                                                                                                                                 | Existing bounded code-local proof                    | Requires the compiler-known intrinsic Array nominal, canonical `Sequence.iter` macro shape, exact element/storage layout, and an effect-free caller. It carries no borrowing summary or provenance state.                                                                                                                                                                                                      | Preserve the generated iterator and `Option` path with general dispatch.                                                                                                             |
| Exact user-iterator specialization: `codegen/optimization/iterator-fast-paths.ts`, `withExactIteratorForCallTargets`                                                                                | None; verified non-consumer                                                                                                                                                 | Existing bounded call-target/type proof              | Requires canonical `Sequence.iter`, an exact nominal receiver, one resolved `iter` target whose body returns a fresh exact nominal, and one matching `next` implementation. It uses existing call targets and receiver/type facts, not the V-500 exact-call borrowing fact.                                                                                                                                    | Leave `call_ref`-based general iterator dispatch in place.                                                                                                                           |
| Ordinary overlap/identity-guard planning: `semantics/borrowing/ordinary-mutation-safety.ts`, `planOrdinaryMutationSafety`/`compareCallAccesses`                                                     | Path-sensitive parameter access, runtime-checked writes, retained/returned provenance, and the guardable-default flag from a composed callable contract                     | Finite ordinary summary                              | Boundary access is the four-field summary. Field, dereference, stable-index, storage, and allocation identity stay local to the caller and current call; pair comparison is bounded by that call's actual parameter accesses and local HIR, with no interprocedural path state. A guard is allowed only for one resolved, non-suspending, ambient-free, callback-free target with complete runtime identities. | Prove local disjointness, emit a bounded runtime identity guard, or report the overlap diagnostic. Incomplete identity, unsafe defaults, or opaque boundaries are rejected.          |
| Deferred-default identity-guard ABI: `codegen/default-identity-guard-entry.ts`, `codegen/default-parameters.ts`, and `codegen/expressions/call/resolved-call.ts`                                    | Per-call `defaultIdentityGuardProtocol` copied from a legacy contract and per-callable `callableRuntimeProtocols`                                                           | Finite ordinary summary plus a one-bit target marker | The local guard planner records `afterDefaults`; the module/package interface publishes only membership in `defaultIdentityGuardTargets`, with no access paths or provenance. A companion is created on demand only for a planned deferred guard.                                                                                                                                                              | Analysis rejects an unguardable default. Codegen fails closed if a planned deferred guard lacks the marker; otherwise the ordinary entry remains guard-free.                         |
| Eager public/package guard-companion publication: base `codegen/functions.ts`, `compileFunctions`                                                                                                   | `CallableBorrowContract.defaultIdentityGuardProtocol` plus export/API/package visibility                                                                                    | Deletion                                             | Eager publication was removed. Demand creation from an actual deferred guard is the sole companion owner, bounded by the set of guard-bearing calls reached by codegen.                                                                                                                                                                                                                                        | Emit only the ordinary entry when no deferred guard is requested.                                                                                                                    |

### Validation and measurement ledger

Static tests below identify the behavior and emitted-shape signal. Runtime and
Wasm columns intentionally remain pending until the same-machine base/head run.
Every acceptance family below uses a closed reason union; source names and
diagnostic text never become metric suffixes. At compiler-perf session start,
`perf-counter-schema.ts` observes every listed decision and reason counter with
an explicit zero. Raw reports can therefore distinguish “the candidate did not
occur” from “the compiler did not publish the metric.”

The concrete counter registry used by this ledger is:

- exact-call facts:
  `codegen.exact_call.{requests,cache_hits,accepted,fallback,fallback.missing-body,fallback.work-budget,fallback.memory-budget,fallback.unsupported-alias,work_units,retained_bytes}`;
- stable-field forwarding:
  `optimize.pass.stable-field-load-forwarding.{candidates,accepted,forwarded_loads,fallback.local-mutation,fallback.local-capture,fallback.local-retention,fallback.local-result-alias,fallback.dynamic-dispatch,fallback.identity-guard,fallback.unresolved-target,fallback.exact-fact-unavailable,fallback.unsafe-boundary,fallback.escape,fallback.retention,fallback.result-alias,fallback.unsupported-argument-plan,fallback.whole-value-access,fallback.candidate-field-write}`;
- mutable aggregate lane ABI:
  `codegen.mutable_scalar_aggregate_lane_abi.{requested,accepted,fallback.missing-body,fallback.missing-module-context,fallback.unsupported-layout,fallback.missing-parameter,fallback.missing-signature,fallback.effectful,fallback.result-abi,fallback.parameter-abi,fallback.optional-parameter,fallback.defaulted-parameter,fallback.parameter-type,fallback.exact-fact-unavailable,fallback.unsafe-boundary,fallback.explicit-void-return,fallback.whole-value-access,fallback.indirect-access,fallback.escape,fallback.retention,fallback.result-alias,fallback.no-writes,fallback.unknown-field}`;
- scalar aggregate promotion:
  `codegen.scalar_aggregate.initializer.{applied,bailout.effectful,bailout.interior_mutability,bailout.no_layout,bailout.address_taken,bailout.too_wide,bailout.mutable_dynamic_use,bailout.identity_observable,bailout.nested_assignment,bailout.handler_capture,bailout.escape_or_shape,bailout.lowering_fallback}`
  and
  `codegen.scalar_aggregate.parameter.{applied,bailout.effectful,bailout.mutable,bailout.escapes,bailout.no_layout,bailout.incompatible_abi,bailout.too_wide,bailout.lane_mismatch}`;
- counted Array proofs: `codegen.safe_array_while.{requested,accepted}`,
  `codegen.safe_array_while.fallback.shape`,
  `codegen.safe_array_while.fallback.{nested-control,control-transfer,array-reassigned,index-update,array-method,dynamic-call,identity-guard,unresolved-call,missing-summary,suspending-call,ambient-access,unknown-callback,parameter-write,array-alias-argument,index-count}`,
  and
  `codegen.range_array_safe_scope.fallback.{nested-control,control-transfer,array-reassigned,index-update,array-method,dynamic-call,identity-guard,unresolved-call,missing-summary,suspending-call,ambient-access,unknown-callback,parameter-write,array-alias-argument,index-count}`;
  the Range-derived family also publishes
  `codegen.range_array_safe_scope.{requested,accepted}`;
- intrinsic loops:
  `codegen.intrinsic_array_for.{requested,accepted,fallback.effectful,fallback.shape}`
  and
  `codegen.intrinsic_range_for.{requested,accepted,fallback.effectful,fallback.shape}`;
- exact iterator specialization:
  `codegen.exact_iterator_for.{requested,accepted,fallback.noncanonical-iter-call,fallback.noncanonical-body,fallback.nonexact-receiver,fallback.unresolved-iter-target,fallback.missing-iter-metadata,fallback.missing-iter-body,fallback.nonfresh-iterator-result,fallback.unresolved-next-target,fallback.missing-next-trait-mapping,fallback.ambiguous-next-implementation}`;
- ordinary identity guards:
  `borrowing.identity_guard.{pairs,static_disjoint,emitted.immediate,emitted.deferred_default,rejected.same-place-overlap,rejected.incomplete-identity,rejected.proven-overlap,rejected.suspending-target,rejected.ambient-access,rejected.unknown-callback,rejected.unresolved-target,rejected.unguardable-default,rejected.missing-expression}`;
- deferred-default companions:
  `codegen.default_identity_guard_companion.{requested,created,reused,compiled,fallback.missing-protocol,fallback.missing-body}`.

The analysis counters are exactly
`borrowing.ordinary.{callables,callEdges,summaryEvaluations,sccReevaluations,retainedSummaryBytes,projectionFamilies,widenings}`
and `borrowing.explicitBorrowFacts`.

| Disposition                          | Focused behavior/emitted-shape test                                                                                                                                                | Acceptance counters and signals                                                                                                                                                                                                                                                        | Benchmark command/artifact                                                                                                                         | Base runtime / Wasm | Head runtime / Wasm |   Ratio | Status                     |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------: | ------------------: | ------: | -------------------------- |
| Footprint adapter deletion           | `stable-field-load-forwarding.test.ts` exact-fact metrics and `std-array-smoke.test.ts` conservative cases                                                                         | Exact-call and ordinary-summary registry entries above; source audit must continue to find no `callableAccesses`/`getFootprint` compatibility adapter.                                                                                                                                 | Covered by each migrated consumer below                                                                                                            |                 N/A |                 N/A |     N/A | Pending final source audit |
| Stable-field call disjointness       | `stable-field-load-forwarding.test.ts`: “forwards a fixed field load across a resolved disjoint call”, same/root writes, dynamic dispatch, and unresolved function-value fallback  | Exact-call and stable-field registry entries above.                                                                                                                                                                                                                                    | `npm run bench:v439 -- --scenario focused-checked-access --samples 7 --runtime-samples 31 --output /tmp/v500-checked-access.json`                  |             Pending |             Pending | Pending | Pending                    |
| Stable-field escape barrier          | `stable-field-load-forwarding.test.ts`: prior result provenance and nested-call fallback cases                                                                                     | The stable-field family above reports distinct `.fallback.{escape,retention,result-alias,local-result-alias,unsafe-boundary}` dispositions in addition to exact-call fact outcomes.                                                                                                    | Same focused checked-access artifact                                                                                                               |             Pending |             Pending | Pending | Pending                    |
| Fresh mutable aggregate lane ABI     | `scalar-aggregate-replacement.test.ts`: updated lanes, repeated wide aliases, exact logical result, materialization fallback, and local-alias fallback                             | Exact-call, mutable-lane, and scalar-aggregate registry entries above.                                                                                                                                                                                                                 | `npm run bench:mutable-result -- --compile-samples 7 --runtime-samples 31 --output /tmp/v500-mutable-result.json`                                  |             Pending |             Pending | Pending | Pending                    |
| Counted `while` Array checked access | `std-array-smoke.test.ts`: “elides ... in safe counted loops” and “keeps Array.at checks when ... invalid”                                                                         | Ordinary-summary and `codegen.safe_array_while` registry entries above.                                                                                                                                                                                                                | `npm run bench:v439 -- --scenario focused-checked-access --samples 7 --runtime-samples 31 --output /tmp/v500-checked-access.json`                  |             Pending |             Pending | Pending | Pending                    |
| Direct intrinsic `Range<i32>` loop   | `range-for-fast-path.test.ts`: pre-Binaryen `range_for_loop`, no `RangeIterator`/`call_ref`, and preserved stable-field forwarding                                                 | `codegen.intrinsic_range_for.{requested,accepted,fallback.{effectful,shape}}`; the acceptance counter, absence of general `RangeIterator` machinery in final WAT, and runtime results are the retained benchmark signals because Binaryen may discard internal block labels.           | `npm run bench:v439 -- --scenario isolated-range-optimizations --samples 7 --runtime-samples 31 --output /tmp/v500-range-optimizations.json`       |             Pending |             Pending | Pending | Pending                    |
| `Range`-derived Array checked access | `std-array-smoke.test.ts` `safe_for_sum` plus helper-mutation fallback/trap cases; `range-for-fast-path.test.ts` verifies the independent Range lowering                           | Ordinary-summary and `codegen.range_array_safe_scope` registry entries above.                                                                                                                                                                                                          | Same isolated Range artifact; separate `range_array_checked_access_workload` runtime and per-export WAT shape                                      |             Pending |             Pending | Pending | Pending                    |
| Intrinsic `Array<T>` iteration       | `array-for-fast-path.test.ts`: intrinsic `array_for_loop` shape and custom/manual fallbacks                                                                                        | `codegen.intrinsic_array_for.{requested,accepted,fallback.{effectful,shape}}`; `array_for_loop`, `call_ref`, Option machinery, and runtime results remain the emitted-shape signals.                                                                                                   | `npm run bench:array-for -- --compile-samples 7 --runtime-samples 31 --output /tmp/v500-array-for.json`                                            |             Pending |             Pending | Pending | Pending                    |
| Exact user-iterator specialization   | `iterator-for-specialization.test.ts`: exact target, wide/object results, and dynamic/noncanonical fallback                                                                        | Exact-iterator registry entries above; `call_ref` and receiver-specialized `next` remain shape signals.                                                                                                                                                                                | `npm run bench:iterator-for -- --compile-samples 7 --runtime-samples 31 --output /tmp/v500-iterator-for.json`                                      |             Pending |             Pending | Pending | Pending                    |
| Ordinary overlap/identity guards     | `borrowed-array-element-views.test.ts`: static disjointness, dynamic allocation/storage/index guards, open trait dispatch, generic instantiation, and optimized/unoptimized parity | Ordinary identity-guard registry entries above.                                                                                                                                                                                                                                        | `bench:v500` `mutation-mixed` series and `npm run bench:v439 -- --samples 7 --runtime-samples 31`                                                  |             Pending |             Pending | Pending | Pending                    |
| Deferred-default guard ABI           | `borrowed-array-element-views.test.ts`: guards after omitted defaults and no companion for a statically safe default; it owns the pre-Binaryen companion-name assertion            | `borrowing.identity_guard.emitted.deferred_default` and `codegen.default_identity_guard_companion.{requested,created,reused,compiled,fallback.{missing-protocol,missing-body}}`; final benchmark WAT retains the identity comparison and panic path after possible companion inlining. | `npm run bench:v439 -- --scenario deferred-default-identity-guard --samples 7 --runtime-samples 31 --output /tmp/v500-deferred-default-guard.json` |             Pending |             Pending | Pending | Pending                    |
| Eager companion deletion             | `borrowed-array-element-views.test.ts`: “does not emit a guarded companion for a statically safe default”                                                                          | Source audit plus absence of `__default_identity_guard_v1`; no runtime acceptance counter applies to the deleted eager path.                                                                                                                                                           | Same focused shape test; no separate runtime path                                                                                                  |                 N/A |                 N/A |     N/A | Pending final source audit |

For a same-machine optimization comparison, run each checkout with the same
fixture revision, compile/runtime sample counts, and environment. Scripts that
accept `--sdk-root` can target another installed checkout directly. Otherwise,
run the same command from each checkout and preserve both JSON documents.

An optimization result is complete only when the row records its new proof
owner, emitted-shape signal, runtime and Wasm distributions, and acceptance or
fallback counts split by reason. A removed or disabled path still needs a row
with the deletion rationale and measured regression. The bounded counter
families above are implemented; their raw counts still need to be captured by
the same-machine acceptance run.

## Final conclusions

### Measured

Pending. Do not place smoke-test timings here.

### Pending

- Run the generated matrix on clean base and head revisions on one machine.
- Confirm every required compiler phase and bounded counter family appears in
  the raw artifacts before judging gates.
- Run the full `pkg::web`, representative full-stack, warm source-only edit,
  and both historical V-499 controls.
- Measure every optimization disposition row and capture its acceptance and
  fallback counts by reason.
- Attach or link immutable raw JSON artifacts and summarize all distributions,
  adjacent scaling ratios, and same-machine base/head ratios.
