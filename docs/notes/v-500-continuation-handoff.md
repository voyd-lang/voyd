# V-500 continuation handoff

Last updated: 2026-08-12 (America/Los_Angeles)

This is the durable restart point for Linear V-500, “Implement scoped explicit
borrows proposal.” Read this file before changing or validating the current
worktree.

## Snapshot

- Worktree: `/Users/drewy/.codex/worktrees/4ffe/voyd`
- Branch: `drew/v-500-implement-scoped-explicit-borrows-proposal`
- Required benchmark base: `b2a35155fca53d1e93e1465a3a4fde2a3f7bd2b0`.
- The validated V-500 implementation is committed and pushed as
  `74227f4d` (`Finish scoped borrow integration`), on top of the original
  implementation checkpoint `06bfff63` and handoff checkpoint `4c28805b`.
- Continue from these commits; do not reset or discard them.
- Linear V-500 is already **In Progress** and assigned to Drew.
- Required PR title: `[V-500] Implement scoped explicit borrows`
- Required PR state: ready for review, not draft.
- The high-assurance review and final repair verification are clean. The last
  accepted finding tightened the Array iterator exception to the canonical
  `std::array::Array` / `ArrayIterator` factory and step identities; its hostile
  lookalike regression is green.

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

The final focused safety run passed 90/90, and compiler TypeScript typechecking
passed.

## Current validated state

The correctness implementation is green and pushed. Final validation completed
on 2026-08-12:

- `npm test`: passed all release lanes;
- `npm run check`: passed all 18 typechecks, lint, and test inventory;
- compiler focused borrowing/ordinary mutation: 90/90;
- compiler codegen: 358/358;
- std: 290/290;
- Web: 129/129;
- conformance: 217/217;
- integration: 143/143 (the localhost HTTP cases require execution outside the
  desktop sandbox);
- `git diff --check`: passed.

The implementation is committed and pushed. Remaining work is performance
measurement, completing `v-500-scoped-borrows-results.md`, publishing a durable
artifact, and opening the ready PR.

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

The final verifier accepted the canonical Array iterator identity repair and
reported a clean verdict. Full release gates then passed.

If further fixes materially change the origin/path model, run one fresh
read-only correctness reviewer over only that changed lens before publishing.

## Commit and benchmark sequence

The implementation commit is `74227f4d` and is already pushed. Continue with:

1. Create a clean detached head checkout at
   `/private/tmp/v500-bench-final/head` from that commit.
2. Run `npm install` in the head checkout so workspace links resolve into that
   checkout.
3. Keep the already-prepared clean base checkout at
   `/private/tmp/v500-bench-final/base` on
   `b2a35155fca53d1e93e1465a3a4fde2a3f7bd2b0`.
4. Write raw output under `/private/tmp/v500-bench-final/results`.
5. Run benchmarks sequentially on AC power with no concurrent build/test work.

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

- Do not reset or discard the V-500 checkpoint commits.
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
