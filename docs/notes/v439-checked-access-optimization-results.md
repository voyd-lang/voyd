# V-439 checked-access optimization results

V-439 measured where Voyd's checked memory-access facts leave avoidable work in
optimized Wasm, then implemented only the opportunities with a repeatable win.
The final branch contains two accepted optimizations:

- V-475 forwards fixed-field loads out of loops when every resolved call is
  proven unable to write the loaded place.
- V-476 lowers `Array.get` to a proven `Some` inside the existing safe counted
  array-loop proof.

## Method

Run the benchmark with:

```sh
npm run bench:v439 -- --label <label> --samples 7 --runtime-samples 31
```

Each reported compile time is the median of seven fresh SDK compiles. Runtime
results are medians of 31 samples after three warmups. Scenarios run in isolated
child processes so differently shaped Binaryen programs cannot share runtime
type state. Code-shape counts are static instruction-site counts over each
complete emitted module.

These measurements used Node 24.18.0 on an Apple M4 Pro with 14 logical CPUs.
The before run used the benchmark commit before either optimization; the after
run used the final integrated V-475 and V-476 commits. Both runs used the same
harness, fixture, sample counts, and machine.

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

## Representative controls

The final Wasm hash and every recorded instruction-site count are identical
before and after for both representative programs, in both compiler modes.
Their small timing movements therefore reflect run-to-run measurement variance
rather than added runtime instructions.

| Scenario | Mode | Compile before -> after | Runtime before -> after | Wasm / gzip |
| --- | --- | ---: | ---: | ---: |
| vtrace | none | 1994.066 -> 1888.228 ms | 419.874 -> 414.341 ms | 166,859 / 42,559 B, identical |
| vtrace | release | 3148.938 -> 3168.819 ms | 83.860 -> 84.448 ms | 34,669 / 12,826 B, identical |
| Scalar aggregate | none | 1406.918 -> 1416.401 ms | 0.173792 -> 0.176958 ms | 37,854 / 9,387 B, identical |
| Scalar aggregate | release | 1624.346 -> 1658.518 ms | 0.040708 -> 0.041875 ms | 1,112 / 677 B, identical |

All representative runs reported zero linear-memory growth.

## Safety boundaries

Stable-field forwarding is limited to fresh nominal objects, fixed field
projections, and resolved callees whose immutable codegen-view footprints prove
that every possible write is disjoint. It bails out for dynamic or method
dispatch, root or same-field writes, external access, suspension, retention or
returned provenance, indexed uncertainty, aliases, capture/escape, and mutable
root replacement.

The `Array.get` fast path reuses the existing zero-start, unit-increment,
length-bounded loop proof. It requires stable array identity, length, and
storage, and bails out for resizing or replacement, array aliases passed to
calls, unknown/effectful calls, stale lengths, non-unit or non-monotonic indices,
nested control flow, and unsupported access shapes. Ordinary `Array.get`
retains its Option behavior outside the proven region.

## Opportunity decisions

| Opportunity | Decision | Reason |
| --- | --- | --- |
| Stable field loads across calls | Accepted as V-475 | Repeatable 19.8% focused win; focused Wasm shrank; representatives were byte-identical. |
| `Array.get` Option traffic in proven loops | Accepted as V-476 | Repeatable 72.3% focused win; focused Wasm shrank; representatives were byte-identical. |
| `SharedCell` runtime-check traffic | Deferred | The focused gap was large, but the representative programs had no meaningful use and explicit shared-cell runtime semantics need a separate design decision. |
| Remaining access guards | Stopped | The existing focused guard benchmark measured about 1.34 ns per call, below the threshold for another optimization ticket. |
| Aggregate materialization | Stopped | Existing scalar-replacement work already removes the representative traffic; measurement found no new checked-access-specific gap. |

Each accepted optimization passed focused runtime and emitted-shape tests,
repository typechecking, the test inventory audit, and an independent Standard
review followed by a fresh verification review.
