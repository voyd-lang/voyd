# V-500 continuation handoff

Last updated: 2026-08-13 (America/Los_Angeles)

This is the durable restart point for Linear V-500, “Implement scoped explicit
borrows proposal.” Read this file before changing or validating the current
worktree.

## Snapshot

- Worktree: `/Users/drewy/.codex/worktrees/4ffe/voyd`
- Branch: `drew/v-500-implement-scoped-explicit-borrows-proposal`
- Required benchmark base: `b2a35155fca53d1e93e1465a3a4fde2a3f7bd2b0`.
- The validated implementation and benchmark-runner fixes are committed and
  pushed through `6dfde641` (`Report V-500 benchmark progress`). The main
  implementation commit is `74227f4d` (`Finish scoped borrow integration`),
  followed by the handoff and runner-fix commits `55975193`, `52f2f41b`, and
  `265a0ea0`.
- Performance artifacts now exist under
  `docs/notes/artifacts/v500/6dfde641/`. The artifact packaging and the final
  edits to this handoff and `v-500-scoped-borrows-results.md` are uncommitted at
  the time of this update; commit and push them together before opening the PR.
- Continue from these commits and files; do not reset or discard them.
- Linear V-500 is already **In Progress** and assigned to Drew.
- Required PR title: `[V-500] Implement scoped explicit borrows`
- Required PR state: ready for review, not draft.
- The high-assurance review and final repair verification are clean. The last
  accepted finding tightened the Array iterator exception to the canonical
  `std::array::Array` / `ArrayIterator` factory and step identities; its hostile
  lookalike regression is green.

No debug logging remains under
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

The implementation is committed and pushed. Bounded clean performance
measurement is complete, its report has been filled with honest conclusions,
and the raw artifacts have been packaged with hashes. The remaining work is to
commit/push the report and artifacts, open the ready PR, and update Linear.

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

Clean detached worktrees were measured at
`/private/tmp/v500-bench-final/{base,head}` using base `b2a35155...` and head
`6dfde641...`. Completed evidence covers four-point ordinary fields/topology,
Borrow calls/callbacks, four usable Borrow-depth points, four-point mixed
mutation, and a warm source-only edit. Exact commands, sample counts,
distributions, counter series, ratios, caveats, and conclusions are now in
`docs/notes/v-500-scoped-borrows-results.md`.

The full matrix was stopped after about an hour because its projected 40–50
minute duration did not add enough information. Web, full-stack, historical,
and optimization companion timings were intentionally not run. Depths 20, 24,
and 32 also exceeded a two-minute command cap; the completed 4/8/12/16 points
show constant explicit-borrow analysis state while both base and head incur a
separate whole-compiler deep-shape cost. Head is faster at every measured depth.

Raw JSON files were deterministically compressed under
`docs/notes/artifacts/v500/6dfde641/`; its README contains raw and compressed
SHA-256 hashes. Dirty one-sample smoke artifacts were excluded. Do not restart
the long matrix unless new evidence points to a real regression.

Next steps:

1. Review `git diff --check` and documentation links.
2. Commit the report, artifact manifest, and compressed JSON files.
3. Push the branch, open the ready PR, and update Linear V-500.

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
