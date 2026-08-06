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
results are medians of 31 samples after three warmups. Each entrypoint gets a
fresh host instance so one stage cannot inherit another stage's GC heap.
Scenarios run in isolated child processes so differently shaped Binaryen
programs cannot share runtime type state. Code-shape counts are static
instruction-site counts over each complete emitted module.

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

Setup, array traversal, and the 10,000-request driver use idiomatic range-based
`for` loops. The 128-node serialization inner loop remains an explicit `while`
loop; the loop-syntax control below shows why that distinction matters with the
current compiler.

The route/view-model and serialization stages are exported separately to
attribute their cost, while `main` measures the integrated handler. The
V-475-only revision is included between the original baseline and the final
branch.

| Release runtime | Baseline | V-475 only | Final | Final vs baseline |
| --- | ---: | ---: | ---: | ---: |
| Integrated request pipeline | 7.945 ms | 7.680 ms | 5.132 ms | **-35.4%** |
| Route and view-model lookup | 3.203 ms | 3.211 ms | 0.691 ms | **-78.4%** |
| Response serialization | 6.225 ms | 6.219 ms | 6.232 ms | +0.1% |

V-475 removes four repeated field-load sites and improved the integrated
pipeline by 3.3%; the isolated serialization timing was unchanged at this
workload size. The lookup movement on that revision was noise: its emitted
lookup path did not change. Adding V-476 improved the lookup stage by 78.5%
relative to V-475 and the integrated pipeline by another 33.2%. Compiler
telemetry reports four forwarded stable loads in the serialization loop.

| Release module metric | Baseline | V-475 only | Final | Final vs baseline |
| --- | ---: | ---: | ---: | ---: |
| Compile median | 1700.449 ms | 1741.339 ms | 1710.165 ms | +0.6% |
| Wasm | 6,195 B | 6,187 B | 5,418 B | -12.5% |
| Gzip | 2,857 B | 2,870 B | 2,558 B | -10.5% |
| Allocation sites | 82 | 82 | 65 | -17 |
| `struct.get` sites | 92 | 88 | 71 | -21 |
| `struct.set` sites | 20 | 20 | 20 | 0 |
| Direct calls | 99 | 99 | 77 | -22 |
| Indirect calls | 41 | 41 | 33 | -8 |
| Linear-memory growth | 0 B | 0 B | 0 B | 0 B |

Without release optimization, the final compiler improved the integrated
pipeline from 45.098 to 30.434 ms (-32.5%) and the lookup stage from 15.107 to
1.175 ms (-92.2%). Serialization moved from 31.661 to 29.342 ms (-7.3%). V-476
is a proven codegen fast path, while V-475 consumes release optimizer facts.
The non-release module shrank by 1.0% before gzip and 1.7% after gzip.

### Counted-loop syntax control

The final compiler was also measured with the fixture's counted loops written
three ways. The hybrid retained below uses `for` for setup, array traversal,
and each 10,000-request driver, while keeping the 128-iteration serialization
inner loop as `while`.

| Final-compiler release metric | All `while` | Idiomatic hybrid | All `for` |
| --- | ---: | ---: | ---: |
| Integrated request pipeline | 5.067 ms | 5.132 ms (+1.3%) | 9.083 ms (+79.3%) |
| Route and view-model lookup | 0.682 ms | 0.691 ms (+1.4%) | 0.679 ms (-0.4%) |
| Response serialization | 7.072 ms | 6.232 ms (-11.9%) | 11.648 ms (+64.7%) |
| Wasm | 4,550 B | 5,418 B (+19.1%) | 5,489 B (+20.6%) |
| Gzip | 2,154 B | 2,558 B (+18.8%) | 2,576 B (+19.6%) |

The array lookup timing confirms that V-476 works with
`for index in 0..array.len()`: that form has a dedicated direct counted-loop
path. A general `for index in 0..N` currently expands through `Range.iter()` and
`next()`. Using that form for the 1.28 million serialization-node iterations
per sample adds iterator allocation and dispatch, and the macro-generated loop
does not expose V-475's stable-load opportunity. The hybrid keeps the requested
idiomatic 10,000-request loops with a 1.3% integrated runtime cost, while
avoiding the large hot-inner-loop regression. Its 18.8% gzip-size cost is the
current price of including general range-iterator machinery in this small
standalone module.

## Unmatched representative controls

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
| Stable field loads across calls | Accepted as V-475 | Repeatable 19.8% focused win; the representative loop removes four repeated field-load sites. |
| `Array.get` Option traffic in proven loops | Accepted as V-476 | Repeatable 72.3% focused win and a 78.4% representative route/view-model lookup win. |
| `SharedCell` runtime-check traffic | Deferred | The focused gap was large, but the representative programs had no meaningful use and explicit shared-cell runtime semantics need a separate design decision. |
| Remaining access guards | Stopped | The existing focused guard benchmark measured about 1.34 ns per call, below the threshold for another optimization ticket. |
| Aggregate materialization | Stopped | Existing scalar-replacement work already removes the representative traffic; measurement found no new checked-access-specific gap. |

Each accepted optimization passed focused runtime and emitted-shape tests,
repository typechecking, the test inventory audit, and an independent Standard
review followed by a fresh verification review.
