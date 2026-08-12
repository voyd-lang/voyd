# V-500 continuation handoff

Last updated: 2026-08-12 (America/Los_Angeles)

This is the durable restart point for Linear V-500, “Implement scoped explicit
borrows proposal.” Read this file before changing or validating the current
worktree.

## Snapshot

- Worktree: `/Users/drewy/.codex/worktrees/4ffe/voyd`
- Branch: `drew/v-500-implement-scoped-explicit-borrows-proposal`
- Current `HEAD` and required benchmark base:
  `b2a35155fca53d1e93e1465a3a4fde2a3f7bd2b0`
- The implementation is still uncommitted on top of that base. The large dirty
  tree is intentional V-500 work; do not reset, restore, or discard it.
- Linear V-500 is already **In Progress** and assigned to Drew.
- Required PR title: `[V-500] Implement scoped explicit borrows`
- Required PR state: ready for review, not draft.
- The high-assurance review loop has run. Its most recent verifier found no
  unresolved material design/correctness finding in the last inspected
  compiler snapshot, but the latest std fallout hunk remains unverified and the
  full-suite release gate has not passed.

All subagents were stopped before this handoff. No debug logging remains under
`packages/compiler/src/semantics/borrowing`.

## What is implemented

The worktree contains the full cross-repository V-500 migration, including:

- normalized `Borrow<T>` syntax and invariant typing;
- removal of prefix `borrow T`, named regions, borrow contracts, result
  provenance contracts, capability tiers, and `ViewIterator`/`view_iter`;
- callable-local scoped-Borrow checking and four-field finite ordinary mutation
  summaries (`parameterAccesses`, `ambientObjectAccess`,
  `invokesUnknownCallback`, `maySuspend`);
- bounded caller-local place/origin checking, runtime identity guards, and
  deferred-default guard companions;
- package semantic interface v3 with signatures/effects/types, finite summaries,
  and the one-bit guard protocol only;
- deletion of durable borrowing-result cache artifacts and their SDK APIs;
- demand-driven exact-call optimization facts for stable-field forwarding and
  mutable scalar-aggregate lane ABI;
- finite-summary Array/Range safety consumers and optimizer telemetry;
- std, Web, conformance, integration, SDK, docs, test inventory, and performance
  runner migrations;
- a performance report scaffold at
  `docs/notes/v-500-scoped-borrows-results.md`.

Public ordinary summaries must remain exactly four fields. Caller-local paths,
result origins, freshness, alias components, and worklists must never enter the
module/package interface.

## Most recent safety repair

The final review exposed caller-local alias and reachable-origin gaps. The
current compiler now has:

- union-find identity aliases plus bounded containment edges for freshness
  invalidation;
- bounded fixed-point propagation for let/assignment/match/loop origins;
- fail-closed widening to all reference-capable parameters when a work budget,
  cycle, or missing path prevents a complete proof;
- child-origin traversal through objects, tuples, and intrinsic Array
  construction;
- caller-local origin places (`{ parameter, path }`) for sibling projection
  precision, consumed only by `callable-borrow-index.ts` and
  `ordinary-mutation-local.ts`;
- whole-parameter caller origin IDs at every ordinary call, module, and package
  boundary;
- exact selected trait overload bounds, explicit closed `: ()` rows, and omitted
  trait rows treated as open/suspending.

The verifier checked these observable cases in the current architecture:

- direct same-body mutation of a fresh wrapper field: accepted;
- the same mutation through a helper boundary: rejected (`TY0048`);
- retained-child reads and writes through helpers: rejected;
- direct sibling projections such as `self.out` and `self.parser`: accepted;
- the same projected path: rejected;
- aggregate, assignment, projected-assignment, helper-of-helper, and loop-carried
  origin laundering: rejected;
- a fresh intrinsic Array containing an aliased child: rejected;
- missing/cyclic/budget-exhausted origin analysis: widened conservatively.

The last completed focused safety run was 84/84, and compiler TypeScript
typechecking passed at that point.

## Critical unverified state

Do not describe the implementation as green yet.

The latest edit in
`packages/compiler/src/semantics/borrowing/ordinary-mutation-local.ts` is around
`placeIsBoundResult` / `retainedReachableAlias` (currently near lines 801–876).
It excludes a bound result from the blanket retained-reachable-alias path so the
dedicated local result-alias solver can own it. This edit was made immediately
before the stop request and has **not** been typechecked or tested.

Run these first:

```sh
git diff --check
npm run typecheck -w @voyd-lang/compiler
npx vitest run --config vitest.config.ts \
  packages/compiler/src/semantics/borrowing/__tests__/borrowing.test.ts \
  packages/compiler/src/semantics/borrowing/__tests__/ordinary-mutation-summary.test.ts \
  --reporter=dot
```

If the new exclusion accepts an unsafe retained result, revert or narrow only
that exclusion. Do not reintroduce callee result provenance or freshness facts.

## Current known failing layer

The std suite is currently failing. At the last exact checkpoint, the primary
residual diagnostics were:

- JSON: 8 `TY0055`
  - `JsonDtoReader.is_complete`, `kind`, `has_next_element`;
  - `JsonReader.is_complete`, `kind`, `has_next_element`;
  - two decode-options overload bounds.
- JSON: 6 `TY0048`
  - the `begin_array` probe pair;
  - the `begin_variant` probe pair;
  - `append_escaped(escape, escaped)`;
  - `fields.set(key, value)`.
- MsgPack: 2 `TY0048`
  - `active.bytes.len()` in `Decoder.can_read`;
  - `active.bytes.at()` in `read_u8`.

The last two MsgPack rewrites were identified but not applied.

The intended repair policy is:

1. preserve whole-parameter coarsening at every call boundary;
2. preserve projected precision only inside the same callable;
3. use direct local projections/intrinsics or independently allocated local
   storage at concrete std fallout sites;
4. do not add compiler-known body/name freshness exceptions;
5. do not add public APIs or change public signatures merely to silence the
   checker;
6. do not broadly rewrite JSON/Web until the precise primary diagnostic has
   been confirmed after the latest compiler hunk.

Array, String, Dict, and Data were already migrated through the conservative
checker. The latest work kept Array fields package-visible (`pub`) rather than
cross-package API-visible (`api`). Recheck this boundary when reviewing the
final diff.

Run std after the three initial commands:

```sh
npm test -w @voyd-lang/std
```

Then address only the primary, non-cascade diagnostics and rerun until 290/290
passes.

## Original full-suite regressions to rerun

Before the final origin work, `npm test` found four real compiler codegen
regressions. The trait/effect implementation was repaired, but the final tree
has not rerun all four together:

```sh
npx vitest run --config vitest.config.ts \
  packages/compiler/src/codegen/__tests__/array-for-fast-path.test.ts \
  packages/compiler/src/codegen/__tests__/codegen.test.ts \
  packages/compiler/src/codegen/__tests__/effects-perform.test.ts \
  --reporter=dot
```

The exact cases were:

- `intrinsic Array<T> for-loop fast path` (`first` was falsely summarized as a
  write through the fresh ArrayIterator cursor);
- `dispatches trait objects with mixed pure/effectful impl ABIs`;
- `preserves local tail continuations through value construction and control
  flow`;
- `specializes locally handled tail effects through value construction and
  control flow`.

Do not change read-only `first<T>(source: Array<T>, ...)` to `~source`; that
workaround was explicitly rejected and reverted.

Also rerun the earlier focused compiler set:

```sh
npx vitest run --config vitest.config.ts \
  packages/compiler/src/compiler-contracts/__tests__/function-contracts.test.ts \
  packages/compiler/src/__tests__/diagnostic-spans.test.ts \
  packages/compiler/src/__tests__/program-symbol-arena.test.ts \
  packages/compiler/src/semantics/__tests__/compiler-function-contracts.test.ts \
  packages/compiler/src/semantics/typing/__tests__/operator-overloads-external.test.ts \
  packages/compiler/src/semantics/typing/__tests__/trait-impls.test.ts \
  --reporter=dot
```

## Web and integration validation

After std and the original codegen cases are green:

```sh
npm test -w @voyd-lang/web
VOYD_USE_SRC=1 node scripts/voyd test \
  packages/web/src/openapi/openapi_app.test.voyd \
  --fail-empty-tests
npm test -w @voyd-lang/conformance-tests
npx vitest run --config vitest.config.ts \
  tests/integration/src/runtime-trap-diagnostics.test.ts \
  tests/integration/src/task-runtime.test.ts \
  --reporter=dot
```

Prior green signals before the last review repairs included std 290/290, Web
129/129, conformance 217/217, task runtime 30/30, runtime trap diagnostics 8/8,
and the Vtrace/Orbit focused performance fixtures. They must be treated as
historical confidence, not validation of the latest hunk.

## Full release gates

Run these only after the focused suites are green:

```sh
npm test
npm run check
git diff --check
```

The first full `npm test` in this desktop sandbox produced `tsx` IPC failures
(`listen EPERM .../tsx-501/*.pipe`) in 17 CLI source e2e cases. Those were
sandbox failures, not product diagnostics. Rerun `npm test` with escalated
execution/outside the sandbox if the same IPC denial appears. That same run also
found the real semantic failures documented above.

Before committing, audit for deleted compatibility state and debug code:

```sh
rg -n \
  'freshResultSymbols|provenanceFreeFreshResult|localCallResult|CallableBorrowContract|CallableAccessIndex|getFootprint|callableAccesses|callableRuntimeProtocols' \
  packages apps tests scripts

rg -n \
  'DEBUG_|v500-debug|ordinary-unknown-call|console\.(log|error|warn)' \
  packages/compiler/src/semantics/borrowing

npm run check:test-inventory
```

Historical/spec prose mentioning removed APIs is allowed. Live compatibility
adapters or debug output are not.

## Review-loop state

The required high-assurance review ran with completeness, design, and
correctness reviewers, followed by repair verification. Accepted material
findings repaired during the loop included:

- deletion of private interprocedural fresh-result/result-origin safety facts;
- bounded fresh-alias invalidation and its prior cubic behavior;
- caller-local uncertain call-result aliasing, including aggregate, match,
  assignment, projected storage, mixed-origin, and loop-carried cases;
- trait declaration mapping across imports;
- exact trait overload selection and correct closed/open effect rows;
- package/cache/codegen removal of legacy borrow metadata;
- runtime guard propagation across installed-package re-exports and cache reuse;
- conservative ambient, callback, suspension, and retained-child boundaries.

The final verifier’s current-snapshot verdict was clean, with one explicit
caveat: final full-suite results remain the release gate because the std fallout
agent was still editing when work stopped.

If further fixes materially change the origin/path model, run one fresh
read-only correctness reviewer over only that changed lens before publishing.

## Commit and benchmark sequence

Do not benchmark the dirty worktree. After all correctness gates pass:

1. Stage and commit the implementation on the current branch.
2. Create a clean detached head checkout at
   `/private/tmp/v500-bench-final/head` from that commit.
3. Run `npm install` in the head checkout so workspace links resolve into that
   checkout.
4. Keep the already-prepared clean base checkout at
   `/private/tmp/v500-bench-final/base` on
   `b2a35155fca53d1e93e1465a3a4fde2a3f7bd2b0`.
5. Write raw output under `/private/tmp/v500-bench-final/results`.
6. Run benchmarks sequentially on AC power with no concurrent build/test work.

The base checkout was already verified clean with local dependencies installed.
Machine recorded for the final report: Mac mini Mac16,11, M4 Pro, 14 cores
(10 performance / 4 efficiency), 48 GB RAM, macOS 26.5.2 (25F84), Node 24.18.0,
npm 11.16.0, AC power. Thermal-status command was unavailable.

Primary commands (run from the clean head checkout):

```sh
BASE=/private/tmp/v500-bench-final/base
HEAD=/private/tmp/v500-bench-final/head
OUT=/private/tmp/v500-bench-final/results
mkdir -p "$OUT"

npm run bench:v500 -- \
  --repo base="$BASE" --repo head="$HEAD" \
  --families all --sizes 4,8,16,32 --modes none,release \
  --samples 7 --warmups 1 --runtime-samples 9 --runtime-min-ms 100 \
  --fail-on-diagnostics \
  --output "$OUT/v500-generated-base-head.json"

npm run bench:v500 -- \
  --repo base="$BASE" --repo head="$HEAD" \
  --scenario ordinary-topology-16 --modes none \
  --samples 7 --warmups 1 --warm-source-edit --fail-on-diagnostics \
  --output "$OUT/v500-warm-edit-base-head.json"

npm run bench:web-openapi -- \
  --repo base="$BASE" --repo head="$HEAD" \
  --compiler-cache none --compile-count 1 \
  --warmups 1 --samples 7 --require-clean \
  --output "$OUT/v500-web-openapi-base-head.json"
```

The Web comparison entry is
`packages/web/src/openapi/openapi_app.test.voyd`, which is unchanged from base;
changes to `packages/web/src/web.test.voyd` do not invalidate that input hash.

Companion benchmarks required by the report:

- `bench:v439` for `representative-web-app-request`,
  `focused-checked-access`, `isolated-range-optimizations`, and
  `deferred-default-identity-guard`, base and head separately with
  `--sdk-root`, 7 compile samples and 31 runtime samples;
- `bench:mutable-result`, `bench:array-for`, and `bench:iterator-for`, base and
  head separately with `--sdk-root`, 7 compile samples and 31 runtime samples;
- `bench:optimizer --preset full --scenarios vtrace-main --modes unoptimized`
  from each checkout, 1 compile warmup, 7 compile samples, 9 runtime samples;
- the selected-provider export-ABI test, one discarded warmup plus 7 alternating
  raw samples per checkout with `VOYD_COMPILER_PERF=1`.

Full exact commands and extraction guidance were prepared in the prior task
context; the benchmark scripts' `--help`, README, and
`docs/notes/v-500-scoped-borrows-results.md` also describe each invocation.
Expected total benchmark wall time is roughly 50–85 minutes.

Important report rule: historical base does not publish every V-500 counter.
Write “not published by base” for missing base call-edge/SCC/projection/fact
metrics. A missing head metric is a blocker; do not report it as zero.

After measurement:

- replace every `Pending` acceptance cell in
  `docs/notes/v-500-scoped-borrows-results.md`;
- include revisions, dirty states, machine/power policy, exact commands,
  distributions, ratios, Wasm sizes/hashes, counter dispositions, and structural
  gates;
- keep all raw JSON/logs unchanged, generate `SHA256SUMS`, and archive them;
- prefer a content-addressed repository artifact under the measured head SHA if
  reasonably small; otherwise use a durable GitHub release asset and commit its
  URL, size, and hashes;
- link the immutable artifact from the report, PR, and Linear ticket.

Commit the measured report/artifact manifest separately after the implementation
benchmark commit if needed, then rerun documentation/check gates appropriate to
that final diff.

## Publish and Linear completion

When validation and performance gates are complete:

```sh
git push -u origin drew/v-500-implement-scoped-explicit-borrows-proposal
```

Open a ready PR against `main` titled:

```text
[V-500] Implement scoped explicit borrows
```

The PR body should summarize the syntax/typing model, finite summary/package
boundary, runtime guards, optimizer migration, std/API migrations, validation,
review repairs, and measured performance artifacts.

Then:

- add the PR and immutable performance artifact links to Linear V-500;
- post the final test/performance summary;
- move V-500 from **In Progress** to **In Review**.

GitHub authentication was already verified for account `drew-y`. Use ready PR,
not draft.

## Things not to do

- Do not reset or restore the large dirty tree.
- Do not recreate legacy borrow contracts, named regions, capability tiers,
  result provenance, or fresh-result interprocedural safety facts.
- Do not adapt the four-field summary into a path-sensitive contract.
- Do not let caller-local paths enter package/cache metadata.
- Do not weaken call-boundary coarsening to avoid std rewrites.
- Do not infer safety from arbitrary callee names/bodies; compiler-known
  exceptions must be closed intrinsic contracts.
- Do not claim the old green suite results validate the latest unverified hunk.
- Do not run performance measurements from a dirty checkout or against the
  merge-base `40bf783...`; the required base is `b2a35155...`.
