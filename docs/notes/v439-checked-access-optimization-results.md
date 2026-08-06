# V-439 checked-access optimization results

V-439 measured where Voyd's checked memory-access facts leave avoidable work in
optimized Wasm, then implemented only the opportunities with a repeatable win.
The final branch contains three accepted optimizations:

- V-475 forwards fixed-field loads out of loops when every resolved call is
  proven unable to write the loaded place.
- V-476 lowers `Array.get` to a proven `Some` inside the existing safe counted
  array-loop proof.
- V-477 recognizes the compiler-owned `Range<i32>` plus the standard `for`
  expansion and emits a direct counted loop instead of allocating an iterator
  and matching `Option` on every iteration.

## Method

Run the benchmark with:

```sh
npm run bench:v439 -- --label <label> --samples 7 --runtime-samples 31
```

Each reported compile time is the median of seven fresh SDK compiles. Runtime
results are medians of 31 samples after three warmups. Each entrypoint gets a
fresh host instance so one stage cannot inherit another stage's GC heap.
Scenarios run in isolated child processes so differently shaped Binaryen
programs cannot share runtime type state. Code-shape counts are static
instruction-site counts over each complete emitted module.

These measurements used Node 24.18.0 on an Apple M4 Pro with 14 logical CPUs.
The focused table measures the original compiler against V-475 and V-476. The
representative web-app table measures four compiler revisions against the same
final all-`for` fixture: original baseline, V-475 only, V-475 plus V-476, and
the final branch with V-477. Every comparison used the same harness, fixture,
sample counts, and machine.

## Focused release results

All runtime entries are milliseconds for the workload defined in
`tests/performance/fixtures/checked-access-optimizer.voyd`.

| Workload | Before | After | Change |
| --- | ---: | ---: | ---: |
| Checked-access projected fields | 0.373625 | 0.375208 | +0.4% |
| Direct stable fields across calls | 0.303459 | 0.243250 | **-19.8%** |
| Manually hoisted stable-field control | 0.245292 | 0.245208 | -0.0% |
| Ordinary mutation control | 0.026208 | 0.026208 | 0.0% |
| `SharedCell` runtime checks | 0.230875 | 0.230167 | -0.3% |
| Proven `Array.at` loop | 0.074792 | 0.070958 | -5.1% |
| Matched `Array.get` loop | 0.255250 | 0.070792 | **-72.3%** |

The stable-field case now matches its manually hoisted control. The matched
`Array.get` case now matches the existing `Array.at` fast path.

| Focused release metric | Before | After | Change |
| --- | ---: | ---: | ---: |
| Compile median | 1758.852 ms | 1765.538 ms | +0.38% |
| Wasm | 7,528 B | 7,010 B | -6.9% |
| Gzip | 2,898 B | 2,685 B | -7.3% |
| Allocation sites | 56 | 51 | -5 |
| `struct.get` sites | 131 | 114 | -17 |
| `struct.set` sites | 15 | 15 | 0 |
| `array.get` sites | 12 | 11 | -1 |
| `array.set` sites | 6 | 6 | 0 |
| `array.len` sites | 4 | 4 | 0 |
| Direct calls | 65 | 55 | -10 |
| Indirect calls | 29 | 26 | -3 |
| Linear-memory growth | 0 B | 0 B | 0 B |

## Non-release control

The same focused module was also measured without release optimization. Compile
time was 1448.440 -> 1449.742 ms (+0.09%), Wasm was 54,536 -> 54,555 bytes
(+0.03%), and gzip was 13,332 -> 13,296 bytes (-0.27%). The matched
`Array.get` workload improved from 0.856292 to 0.305583 ms (-64.3%); the other
focused runtimes moved by at most 5.2%.

## Representative web-app request pipeline

`web-app-request-pipeline.voyd` models the CPU-bound part of a server-rendered
product page after network and database I/O completes. Each 10,000-request
batch performs:

- indexed route selection over a stable route table;
- product-card view-model construction over a stable catalog;
- `Array.get` handling as an application would use before V-476; and
- serialization of a 128-node response using stable template, locale,
  escaping, and hydration configuration while a writer updates response byte
  and node counters.

Every counted loop uses idiomatic range-based `for` syntax, including the
10,000-request drivers and the 128-node serialization inner loop.

The route/view-model and serialization stages are exported separately to
attribute their cost, while `main` measures the integrated handler.

| Release runtime | Baseline | V-475 | + V-476 | + V-477 final | Final vs baseline |
| --- | ---: | ---: | ---: | ---: | ---: |
| Integrated request pipeline | 14.170 ms | 14.192 ms | 9.171 ms | 5.103 ms | **-64.0%** |
| Route and view-model lookup | 3.275 ms | 3.261 ms | 0.691 ms | 0.644 ms | **-80.3%** |
| Response serialization | 11.810 ms | 11.714 ms | 11.789 ms | 7.059 ms | **-40.2%** |

V-475 alone cannot see through the macro-generated iterator's `.next()` call,
so this all-`for` fixture does not benefit until V-477 removes that plumbing
and uses callable access footprints to prove the synthetic method call
disjoint. V-476 then cuts the array-heavy lookup stage by 78.8%. V-477 cuts the
remaining integrated runtime by 44.3% and serialization by 40.1%. Compiler
telemetry reports four forwarded V-475 loads in the final serialization loop.

| Release module metric | Baseline | V-475 | + V-476 | + V-477 final | Final vs baseline |
| --- | ---: | ---: | ---: | ---: | ---: |
| Compile median | 1768.823 ms | 1758.027 ms | 1770.576 ms | 1739.948 ms | -1.6% |
| Wasm | 6,262 B | 6,262 B | 5,489 B | 4,579 B | -26.9% |
| Gzip | 2,884 B | 2,884 B | 2,576 B | 2,147 B | -25.6% |
| Allocation sites | 86 | 86 | 69 | 38 | -48 |
| `struct.get` sites | 92 | 92 | 75 | 52 | -40 |
| `struct.set` sites | 20 | 20 | 20 | 16 | -4 |
| Direct calls | 103 | 103 | 81 | 53 | -50 |
| Indirect calls | 42 | 42 | 34 | 26 | -16 |
| Linear-memory growth | 0 B | 0 B | 0 B | 0 B | 0 B |

Without release optimization, the final compiler improves the integrated
pipeline from 62.539 to 30.883 ms (-50.6%), lookup from 15.475 to 1.221 ms
(-92.1%), and serialization from 47.200 to 29.630 ms (-37.2%). The non-release
module shrinks from 56,626 to 53,925 bytes (-4.8%) and from 13,950 to 13,074
bytes after gzip (-6.3%). V-476 and V-477 are proven codegen fast paths;
V-475 additionally consumes release optimizer facts.

### Counted-loop syntax control

Before V-477, using `for` for every counted loop made the integrated pipeline
79.3% slower than the original all-`while` control. With V-477, the idiomatic
source is effectively at parity with that control:

| Final release metric | All-`while` control | All-`for` with V-477 | Change |
| --- | ---: | ---: | ---: |
| Integrated request pipeline | 5.067 ms | 5.103 ms | +0.7% |
| Route and view-model lookup | 0.682 ms | 0.644 ms | -5.6% |
| Response serialization | 7.072 ms | 7.059 ms | -0.2% |
| Wasm | 4,550 B | 4,579 B | +0.6% |
| Gzip | 2,154 B | 2,147 B | -0.3% |

The direct path recognizes only the validated standard intrinsic
`Range<i32>` and the exact standard `for` expansion. It evaluates bounded range
endpoints once in source order, advances iterator state before the user body so
`continue` remains correct, handles inclusive `i32::MAX` without overflow, and
reuses V-476's array-stability scope for `0..array.len()`. Effectful functions
conservatively keep the normal continuation-aware iterator path.

## Unmatched representative controls

The final Wasm hash and every recorded instruction-site count are identical
before and after for both representative programs, in both compiler modes.
Their small timing movements therefore reflect run-to-run measurement variance
rather than added runtime instructions.

| Scenario | Mode | Compile before -> after | Runtime before -> after | Wasm / gzip |
| --- | --- | ---: | ---: | ---: |
| vtrace | none | 1868.779 -> 1803.813 ms | 413.442 -> 416.026 ms | 166,859 / 42,559 B, identical |
| vtrace | release | 3181.175 -> 3126.605 ms | 81.993 -> 82.598 ms | 34,669 / 12,826 B, identical |
| Scalar aggregate | none | 1362.637 -> 1368.629 ms | 0.181083 -> 0.169583 ms | 37,854 / 9,387 B, identical |
| Scalar aggregate | release | 1587.866 -> 1606.815 ms | 0.041125 -> 0.040834 ms | 1,112 / 677 B, identical |

All representative runs reported zero linear-memory growth.

## Safety boundaries

Stable-field forwarding is limited to fresh nominal objects, fixed field
projections, and resolved callees whose immutable codegen-view footprints prove
that every possible write is disjoint. It bails out for dynamic method
dispatch that receives the candidate, unresolved calls, root or same-field
writes, external access, suspension, retention or returned provenance, indexed
uncertainty, aliases, capture/escape, and mutable root replacement. Resolved
method calls use the same callable-access proof as ordinary calls.

The `Array.get` fast path reuses the existing zero-start, unit-increment,
length-bounded loop proof. It requires stable array identity, length, and
storage, and bails out for resizing or replacement, array aliases passed to
calls, unknown/effectful calls, stale lengths, non-unit or non-monotonic indices,
nested control flow, and unsupported access shapes. Ordinary `Array.get`
retains its Option behavior outside the proven region.

The `Range<i32>` fast path requires the validated std intrinsic type, its exact
`i32` argument, both bounded endpoints, literal inclusive/exclusive mode, and
the exact std `for` macro shape. Other range instantiations, open-ended ranges,
arbitrary iterators, malformed expansions, and effectful functions use normal
iteration. Bounds are evaluated once before any forwarded field loads.

## Opportunity decisions

| Opportunity | Decision | Reason |
| --- | --- | --- |
| Stable field loads across calls | Accepted as V-475 | Repeatable 19.8% focused win; the representative loop removes four repeated field-load sites. |
| `Array.get` Option traffic in proven loops | Accepted as V-476 | Repeatable 72.3% focused win and a 78.8% representative route/view-model lookup win. |
| Intrinsic `Range<i32>` iterator traffic | Accepted as V-477 | Restores all-`for` source to all-`while` parity; cuts the incremental integrated pipeline by 44.3%, serialization by 40.1%, and gzip size by 16.7%. |
| `SharedCell` runtime-check traffic | Deferred | The focused gap was large, but the representative programs had no meaningful use and explicit shared-cell runtime semantics need a separate design decision. |
| Remaining access guards | Stopped | The existing focused guard benchmark measured about 1.34 ns per call, below the threshold for another optimization ticket. |
| Aggregate materialization | Stopped | Existing scalar-replacement work already removes the representative traffic; measurement found no new checked-access-specific gap. |

Each accepted optimization passed focused runtime and emitted-shape tests,
repository typechecking, the test inventory audit, and an independent Standard
review followed by a fresh verification review.
