# V-499 compiler performance findings

This note preserves the 11 August 2026 investigation into compiler and CI
slowdowns observed while completing V-499. It is intended as input to a future
borrowing-analysis redesign. The measurements compare the Voyd Orbit hardening
revision `f395d78c` with V-499 revision `8865d267` unless stated otherwise.

## Summary

Two separate effects were present:

1. Dependency snapshot clones shared their mutable symbol tables with the
   canonical cache entry. Lazy import hydration during `src` analysis could
   therefore mutate cached dependency semantics. A source-import cache-key
   guard hid the ownership bug by forcing cold compiles. V-499 now clones the
   symbol tables, removes the guard, and safely reuses dependency semantics
   across changes to source import selection and aliases.
2. Boundary-enabled cold compiles perform materially more borrowing work after
   the typed `DataValue` and MessagePack provider expansion. The work grows
   faster than the number of analyzed functions, especially in contract
   inference and compact-contract composition. This remains relevant to a
   future borrowing-analysis redesign.

The GitHub Actions compiler-codegen test body changed as follows:

| Measurement | Orbit hardening |    V-499 | Change |
| ----------- | --------------: | -------: | -----: |
| Shard 1     |        316.77 s | 425.48 s | +34.3% |
| Shard 2     |        250.86 s | 445.77 s | +77.7% |
| Combined    |        567.63 s | 871.25 s | +53.5% |
| Tests       |             355 |      352 |  -0.8% |

Setup time was slightly lower on V-499. The increase was inside the tests, not
checkout, dependency installation, or runner provisioning.

## Dependency snapshot source-import leak

The dependency snapshot key temporarily included the source module's exact
import surface. This was broader than the cache boundary documented in
`docs/compiler-performance.md`: the snapshot contains only non-`src` semantics,
and every `src` module is reanalyzed against a cloned dependency typing state.

The non-source module fingerprints already include each loaded std/package
module's source, origin, dependencies, package root, source files, and macro
exports. Changing a source import so that it loads a different dependency set
therefore changes the fingerprint set. Changing only import selection or an
alias should remain a cache hit.

The integration lane exposed this because one SDK instance compiles several
different source snippets. With the source import surface in the key, every
snippet discarded all cached std and package semantics.

Hosted integration measurements:

| Measurement                      | Orbit hardening |          V-499 |
| -------------------------------- | --------------: | -------------: |
| Lane wall time                   |        288.24 s |       785.22 s |
| Sum of assertion durations       |        381.93 s |     1,223.04 s |
| `pkg::web` dynamic compile tests | about 13 s each | 104-119 s each |

Two of those tests exceeded their 60-second limits. The current full web
analysis also reached about 2 GiB RSS locally, so two hosted Vitest workers
amplified the repeated cold analyses through memory and garbage-collection
pressure.

A focused two-compile ablation measured the potential cache benefit:

| Measurement            |    Guarded key | Unguarded key |
| ---------------------- | -------------: | ------------: |
| Test duration          |        69.36 s |       40.71 s |
| First fixture compile  | 37.07 s, miss | 37.26 s, miss |
| Source-snippet compile | 31.00 s, miss |  2.16 s, hit |

The cache hit reused 64 std modules and 40 package modules. The source module
was still reanalyzed, and changing a wildcard import to a named alias produced
no diagnostics in the focused unit case.

That focused case was insufficient. The exact integration command used by CI,
with two Vitest workers, failed three positive `pkg::web` tests after the guard
was removed. Reused `std::dict` semantics reported `TY0008` for valid `next`
overloads.

The precise leak was in `cloneSemanticsForTypingState`. It cloned the type
arena, stores, maps, and export table, but retained the dependency semantic
result's mutable `SymbolTable` through both `binding.symbolTable` and the
semantics-internal symbol-table field. Source typing creates dependency contexts
for lazy imported type, trait, and overload hydration. That hydration copies
importable metadata onto the dependency context's symbol table. Because the
table still belonged to the canonical cache entry, consecutive source compiles
accumulated metadata in the snapshot. A three-source reproduction was required:
either intermediate `pkg::web` source followed by the timeout source passed,
while both intermediate sources followed by it produced the `std::dict.next`
failure.

The fix gives every prepared cache hit an independent cloned symbol table and
uses the same clone from the returned binding and internal semantics field.
The cache key no longer includes `sourceImports`. Dependency module additions,
removals, content changes, roots, and compiler options remain represented by
the existing fingerprints and key fields. A focused compiler regression
mutates metadata in one prepared snapshot and verifies that a later hit sees
the original cached state.

The test batching remains useful independently of the cache fix. Five positive
`pkg::web` source snippets that loaded the same large provider graph are now
entry points in the existing shared integration fixture. They compile once.
The negative route-DSL test remains a separate compile because its diagnostic
is the behavior under test. This follows the repository's test-cost guidance.

## Borrowing-analysis growth

The compiler-codegen lane does not use the SDK dependency snapshot, so its
remaining slowdown is a cold-compile signal. `VOYD_COMPILER_PERF=1` showed
semantic and borrowing analysis dominating representative boundary compiles;
Wasm emission was a smaller part of the total.

The `boundary-export-collision.voyd` fixture was byte-identical at the two
revisions and provides a focused selected-provider comparison:

| Phase or counter               | Orbit hardening |       V-499 |  Change |
| ------------------------------ | --------------: | ----------: | ------: |
| Total compile                  |     1,310.05 ms | 2,509.77 ms |  +91.6% |
| `analyzeBorrowing`             |       428.01 ms | 1,039.30 ms | +142.8% |
| Contract computation           |       322.46 ms |   856.55 ms | +165.6% |
| Compact-contract composition   |       275.88 ms |   764.85 ms | +177.2% |
| Contract inference             |       166.64 ms |   574.34 ms | +244.7% |
| Loan checking                  |        98.52 ms |   172.37 ms |  +75.0% |
| Summary functions              |           1,093 |       1,701 |  +55.6% |
| Total callables                |           2,048 |       2,934 |  +43.3% |
| Borrowing fact operations      |          19,548 |      31,243 |  +59.8% |
| Full contract evaluations      |             564 |         886 |  +57.1% |
| Compact contract evaluations   |           1,119 |       1,507 |  +34.7% |
| Flow widenings                 |             153 |       2,274 |   14.9x |
| Typing constraint-cache hits   |          37,833 |      90,917 | +140.3% |
| Typing constraint-cache misses |           3,182 |       4,218 |  +32.6% |

The function and fact counts grew roughly 56-60%, while inference and
composition time grew 2.7-3.4x. This is direct evidence of superlinear behavior
for this provider topology, rather than compile time increasing only in
proportion to source or function count.

A module-attribution run for the selected provider found a net 608 additional
borrowing summary functions concentrated in:

- `std::msgpack::fns`: +343
- `std::data`: +269
- `std::msgpack`: +25

Other modules offset part of that gross increase. The provider-neutral DTO
reader/writer implementation introduces generic and trait-connected flows with
many projected origins. The large increase in `flowWidenings` suggests that
path-sensitive origin families and their conservative widening are an
important stress point for the current summary fixed point.

An effects test that explicitly disables the host boundary changed from
30.99 s to 32.99 s (+6.5%). This localizes most of the larger regression to the
selected host-provider graph rather than a compiler-wide slowdown affecting
all Voyd programs equally.

## Profiling method

Compiler phase summaries were captured with:

```sh
VOYD_COMPILER_PERF=1 node ../../node_modules/vitest/vitest.mjs run \
  --config ../../vitest.config.ts \
  --testTimeout 120000 --hookTimeout 120000 \
  src/codegen/__tests__/export-abi.test.ts \
  --reporter=dot --disableConsoleIntercept
```

The investigation aggregated the emitted `[voyd:compiler:perf]` records by
phase and counter. Reference sources were checked out separately while sharing
the same installed Node dependencies. CI comparisons used the Actions job
timestamps and uploaded Vitest JSON timing artifacts.

## Inputs for a borrowing-analysis redesign

Retain these measurements when evaluating a replacement:

- summary functions and total callables;
- fact operations and materialized full facts;
- full and compact contract evaluations;
- SCC evaluations and reused callables;
- demanded and detailed summaries;
- flow widenings and projection-family cardinality;
- retained contract count and bytes;
- result-provenance unknown reasons;
- time in inference, compact composition, loan checking, fact construction,
  and result provenance;
- peak RSS as well as wall time.

Useful benchmark shapes are:

1. the small `boundary-export-collision.voyd` selected-provider compile;
2. an equivalent host-boundary-disabled compile;
3. the full `pkg::web` package cold compile;
4. a warm source-only edit through one SDK instance;
5. a provider-heavy generic DTO with nested records, variants, and callbacks.

A redesign should specifically test whether phase time stays close to growth in
callables and facts, whether projected-origin families remain bounded before a
large fixed point forms, and whether dependency summaries can be reused
without retaining source-specific state. For dependency snapshots, the
two-worker `pkg::web` integration workload remains a correctness gate: a
focused alias-only test did not exercise the mutable symbol-table leak that
failed here.
