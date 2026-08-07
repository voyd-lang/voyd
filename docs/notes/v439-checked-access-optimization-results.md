# V-439 checked-access optimization results

V-439 measured where Voyd's checked memory-access facts leave avoidable work in
optimized Wasm, then implemented only the opportunities with a repeatable win.
The final branch contains six accepted optimizations:

- V-475 forwards fixed-field loads out of loops when every resolved call is
  proven unable to write the loaded place.
- V-476 lowers `Array.get` to a proven `Some` inside the existing safe counted
  array-loop proof.
- V-477 recognizes the compiler-owned `Range<i32>` plus the standard `for`
  expansion and emits a direct counted loop instead of allocating an iterator
  and matching `Option` on every iteration.
- V-479 keeps eligible fresh mutable objects in scalar lanes across exact,
  pure mutable-borrow calls and returns the updated lanes directly instead of
  allocating and repeatedly loading and storing a heap object.
- Intrinsic `Array<T>` iteration recognizes the exact standard `for` expansion
  and emits direct array traversal without allocating `ArrayIterator` or
  constructing and matching `Option` for every element.
- General exact-iterator specialization proves fresh concrete iterator results
  from canonical standard `Sequence.iter` implementations, directly targets
  their standard `Iterator.next` implementation, and exposes the unchanged
  iterator state machine to Binaryen scalar replacement.

## Method

Run the benchmark with:

```sh
npm run bench:v439 -- --label <label> --samples 7 --runtime-samples 31
```

Run the two iterator follow-up benchmarks with:

```sh
npm run bench:array-for -- \
  --label <label> \
  --compile-samples 5 \
  --runtime-samples 21

npm run bench:iterator-for -- \
  --label <label> \
  --compile-samples 7 \
  --runtime-samples 31
```

The V-439 and general-iterator compile times are medians of seven fresh SDK
compiles, and their runtimes are medians of 31 samples after three warmups. The
Array follow-up uses five compile and 21 runtime samples. Each V-439 entrypoint
gets a fresh host instance so one stage cannot inherit another stage's GC heap.
Scenarios run in isolated child processes so differently shaped Binaryen
programs cannot share runtime type state. Code-shape counts are static
instruction-site counts over each complete emitted module.

These measurements used Node 24.18.0 on an Apple M4 Pro with 14 logical CPUs.
The focused table measures the original compiler against V-475 and V-476. The
representative web-app table measures four compiler revisions against the same
final all-`for` fixture: original baseline, V-475 only, V-475 plus V-476, and
V-477. V-479 was then measured against the merged V-477 branch with the same
harness, fixtures, sample counts, and machine. The final overall comparison
uses the original baseline and the combined accepted end state after both
iterator follow-ups.

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

### V-479 focused increment

V-479 directly exercises the two focused functions that create mutable records,
retain immutable aliases, and repeatedly call an exact field mutator. The
projected-array case remains outside the proof because the mutable records come
from array element views.

| Focused release workload | V-477 | + V-479 | Change |
| --- | ---: | ---: | ---: |
| Checked-access projected fields | 0.358875 | 0.372208 | +3.7% |
| Direct stable fields across calls | 0.268875 | 0.026916 | **-90.0%** |
| Manually hoisted stable-field control | 0.241375 | 0.026958 | **-88.8%** |
| Ordinary mutation control | 0.023542 | 0.023542 | 0.0% |
| `SharedCell` runtime checks | 0.223709 | 0.229375 | +2.5% |
| Proven `Array.at` loop | 0.070625 | 0.071000 | +0.5% |
| Matched `Array.get` loop | 0.070458 | 0.070667 | +0.3% |

The direct and manually hoisted workloads now run at roughly the ordinary
mutation control's cost. The full focused release module changes as follows:

| Focused release metric | V-477 | + V-479 | Change |
| --- | ---: | ---: | ---: |
| Compile median | 1608.537 ms | 1640.757 ms | +2.0% |
| Wasm | 7,010 B | 6,968 B | -0.6% |
| Gzip | 2,685 B | 2,694 B | +0.3% |
| Allocation sites | 51 | 47 | -4 |
| `struct.get` sites | 114 | 108 | -6 |
| `struct.set` sites | 15 | 15 | 0 |

Without release optimization, the focused module's Wasm hash, byte size, and
every instruction-site count are identical before and after V-479.

## How V-479 transforms Voyd

V-479 keeps a fresh mutable object in scalar Wasm values even when the object
crosses an eligible function call. It does this by specializing the callee's
internal Wasm ABI. It does not inline the function or change the source-level
Voyd API.

Consider a reduced version of the response-writer pattern exercised by the
representative web application:

```voyd
obj Writer {
  bytes: i32,
  nodes: i32,
  escape_cost: i32
}

fn append_node(~writer: Writer, width: i32) -> void
  writer.bytes = writer.bytes + width + writer.escape_cost
  writer.nodes = writer.nodes + 1

pub fn render(count: i32) -> i32
  let ~writer = Writer {
    bytes: 0,
    nodes: 0,
    escape_cost: 3
  }

  for i in 0..count:
    append_node(~writer, i)

  writer.bytes + writer.nodes
```

Without V-479, the compiler must preserve `writer` as a Wasm GC object across
the call. Conceptually, it allocates the object, passes its reference to
`append_node`, and performs `struct.get` and `struct.set` operations in the
callee:

```text
writer_ref = allocate Writer(0, 0, 3)

for i in 0..count:
  append_node(writer_ref, i)

load(writer_ref.bytes) + load(writer_ref.nodes)
```

When V-479's proof succeeds, the compiler instead keeps each field in a local
scalar lane. The following is explanatory pseudocode rather than valid Voyd:

```text
writer_bytes = 0
writer_nodes = 0
writer_escape_cost = 3

for i in 0..count:
  (writer_bytes, writer_nodes, writer_escape_cost) =
    append_node$scalar(
      writer_bytes,
      writer_nodes,
      writer_escape_cost,
      i
    )

writer_bytes + writer_nodes
```

The specialized callee receives the fields as individual Wasm parameters,
operates on locals, and returns their updated state as a Wasm multivalue:

```text
append_node$scalar(bytes, nodes, escape_cost, width):
  updated_bytes = bytes + width + escape_cost
  updated_nodes = nodes + 1
  return (updated_bytes, updated_nodes, escape_cost)
```

The caller captures those returned values back into the same scalar lanes. For
the matching case, no `struct.new`, `struct.get`, or `struct.set` is needed for
the source object.

Immutable aliases continue to observe the same logical state:

```voyd
let ~writer = Writer { bytes: 0, nodes: 0, escape_cost: 3 }
let writer_alias = writer

append_node(~writer, 20)
writer_alias.bytes
```

Both names are represented by the same lane group. If a later operation needs
observable object identity or crosses a boundary that does not support the
lane ABI, the compiler materializes one ordinary object and reconnects all of
its aliases to it.

The optimization requires a fresh object proven not to escape, one exact and
pure callee, a `void` return, and a first mutable-borrow parameter used only
through known direct fields. It rejects calls that may retain or return the
object, suspend, perform external access, observe runtime identity, introduce
unsupported aliases, or exceed the specialization budget. Rejected calls keep
the normal reference ABI.

This transformation depends directly on Voyd's memory-safety analysis. Escape
facts prove where the object's identity can be observed. Callable access
summaries prove that the exact callee cannot hide the reference or read and
write storage outside its declared field footprint. Together, those facts make
it sound to replace one heap identity with independent scalar values across a
mutable call.

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

| Release runtime | Baseline | V-475 | + V-476 | + V-477 stage | V-477 vs baseline |
| --- | ---: | ---: | ---: | ---: | ---: |
| Integrated request pipeline | 14.170 ms | 14.192 ms | 9.171 ms | 5.103 ms | **-64.0%** |
| Route and view-model lookup | 3.275 ms | 3.261 ms | 0.691 ms | 0.644 ms | **-80.3%** |
| Response serialization | 11.810 ms | 11.714 ms | 11.789 ms | 7.059 ms | **-40.2%** |

V-475 alone cannot see through the macro-generated iterator's `.next()` call,
so this all-`for` fixture does not benefit until V-477 removes that plumbing
and uses callable access footprints to prove the synthetic method call
disjoint. V-476 then cuts the array-heavy lookup stage by 78.8%. V-477 cuts the
remaining integrated runtime by 44.3% and serialization by 40.1%. Compiler
telemetry reports four forwarded V-475 loads in the V-477 serialization loop.

| Release module metric | Baseline | V-475 | + V-476 | + V-477 stage | V-477 vs baseline |
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

Without release optimization, the V-477 compiler improves the integrated
pipeline from 62.539 to 30.883 ms (-50.6%), lookup from 15.475 to 1.221 ms
(-92.1%), and serialization from 47.200 to 29.630 ms (-37.2%). The non-release
module shrinks from 56,626 to 53,925 bytes (-4.8%) and from 13,950 to 13,074
bytes after gzip (-6.3%). V-476 and V-477 are proven codegen fast paths;
V-475 additionally consumes release optimizer facts.

### V-479 mutable-object increment

The writer state in the serialization stage is a fresh mutable object with
immutable aliases. Its exact callees are pure, return `void`, and access only
known direct fields. V-479 proves that boundary once, passes the object's fields
as scalar Wasm values, and returns the updated fields as a multivalue result.

| Release runtime | V-477 | + V-479 final | Change |
| --- | ---: | ---: | ---: |
| Integrated request pipeline | 5.094708 ms | 2.847125 ms | **-44.1%** |
| Route and view-model lookup | 0.643083 ms | 0.643375 ms | 0.0% |
| Response serialization | 7.046667 ms | 2.154000 ms | **-69.4%** |

| Release module metric | V-477 | + V-479 final | Change |
| --- | ---: | ---: | ---: |
| Compile median | 1640.083 ms | 1653.090 ms | +0.8% |
| Wasm | 4,579 B | 4,219 B | -7.9% |
| Gzip | 2,147 B | 2,008 B | -6.5% |
| Allocation sites | 38 | 30 | -8 |
| `struct.get` sites | 52 | 38 | -14 |
| `struct.set` sites | 16 | 10 | -6 |
| Direct calls | 53 | 51 | -2 |
| Indirect calls | 26 | 24 | -2 |
| Linear-memory growth | 0 B | 0 B | 0 B |

The serialization result reaches the manual scalar-control ceiling. In
non-release mode, the module hash, byte size, and every instruction-site count
remain identical; integrated, lookup, and serialization medians moved by
-0.2%, +2.5%, and +0.1%, respectively.

Across the complete V-439 branch, the original release pipeline moves from
14.170 to 2.847 ms (-79.9%), lookup from 3.275 to 0.643 ms (-80.4%), and
serialization from 11.810 to 2.154 ms (-81.8%). The release module shrinks from
6,262 to 4,219 bytes (-32.6%) and from 2,884 to 2,008 bytes after gzip (-30.4%).

### Counted-loop syntax control

Before V-477, using `for` for every counted loop made the integrated pipeline
79.3% slower than the original all-`while` control. With V-477, the idiomatic
source is effectively at parity with that control:

| V-477 release metric | All-`while` control | All-`for` with V-477 | Change |
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

## Intrinsic Array `for` follow-up

`Array<T>` is a compiler-owned intrinsic type. The follow-up recognizes the
exact standard expansion of `for element in array`, evaluates the array once,
and directly reads its count, current backing storage, and element. It advances
the synthetic cursor before the user body so `continue` retains its original
meaning.

The lowering re-reads count and storage every iteration. That preserves the
existing `ArrayIterator` behavior when the body grows the array, triggers
backing-storage replacement, or mutates it through an alias. Reassigning the
source variable does not retarget iteration because the original array value is
captured once. Custom and non-intrinsic `Sequence` implementations remain on
the general iterator path.

The benchmark traverses 48 view-model records. Its light-body case isolates
iterator overhead, while the rendering case performs record-based response
size calculation representative of serialization work.

| Release runtime | General Array iterator | Intrinsic direct path | Indexed control | Change |
| --- | ---: | ---: | ---: | ---: |
| Light element loop | 3.264 ms | 0.143 ms | 0.145 ms | **-95.6%** |
| View-model serialization | 1.708 ms | 0.150 ms | 0.154 ms | **-91.2%** |

| Release module metric | Before | Array path | Change |
| --- | ---: | ---: | ---: |
| Wasm | 4,078 B | 3,018 B | -26.0% |
| Gzip | 1,956 B | 1,482 B | -24.2% |
| Indirect calls | 23 | 12 | -11 |
| Allocation sites | 31 | 18 | -13 |

Five uncached compiles and 21 warmed runtime samples were used. The adjacent
compile medians were 1,606.9 and 1,602.7 ms (-0.3%); later reruns were noisy,
so this is evidence of no material compile regression rather than a compile
speedup. On the combined final branch, the same benchmark is 2,880 bytes
(1,413 gzip) and retains indexed-loop runtime parity.

## General exact-iterator follow-up

The general path applies to non-intrinsic user types implementing the standard
`Sequence` and `Iterator` traits. It requires an exact nominal iterable, an
exact selected `iter` implementation, and a fresh concrete nominal iterator
returned directly by that implementation. It uses the selected generic
function instance when the iterator is generic, resolves exactly one canonical
standard `Iterator.next` implementation for that returned type, and scopes the
direct target to the macro-generated call.

The iterator still has its ordinary source-level object representation and
`next() -> Option<T>` ABI. Exact receiver specialization removes dynamic
dispatch and permits direct field stores under the same exact nominal-type fact
already used for direct field loads. Binaryen then inlines the state machine
and removes the iterator and `Option` objects when its own escape analysis
proves them unobservable. This avoids a new combined value-plus-mutable-state
ABI and naturally preserves early returns, variable strides, skipped values,
aliases, wide and object results, and existing fallback behavior.

The representative case uses a filtered, strided iterator whose `next` method
performs variable internal work and returns early when it finds a usable value.

| Release runtime | General dispatch | Exact specialization | Manual state machine | Change |
| --- | ---: | ---: | ---: | ---: |
| Light user iterator | 2.472 ms | 0.385 ms | 0.309 ms | **-84.4%** |
| Filtered/strided traversal | 0.992 ms | 0.440 ms | 0.398 ms | **-55.7%** |

| Release module metric | Before | After | Change |
| --- | ---: | ---: | ---: |
| Wasm | 2,221 B | 1,654 B | -25.5% |
| Gzip | 1,088 B | 781 B | -28.2% |
| Indirect calls | 4 | 0 | -4 |
| Allocation sites | 15 | 0 | -15 |
| `struct.get` sites | 13 | 0 | -13 |
| `struct.set` sites | 7 | 0 | -7 |

Seven uncached compiles and 31 warmed runtime samples were used. Compile median
moved from 1,554.7 to 1,588.3 ms (+2.2%), which is inconclusive at this sample
count. A parent rerun reproduced the final emitted shape and measured 0.354 ms
for the light loop and 0.423 ms for the filtered traversal.

Dynamic or ambiguous dispatch, noncanonical traits, non-fresh iterator
results, unsupported result control flow, and builds without release optimizer
facts keep the ordinary trait call. The intrinsic Array path retains its
stricter requirement that both implementations belong to std.

## Final representative results with iterator follow-ups

The complete representative suite was rerun after both iterator optimizations.
These rows compare the original PR base with the combined final branch using
the same final fixtures and harness.

| Representative release program | Before PR | Final | Change |
| --- | ---: | ---: | ---: |
| Vtrace renderer | 79.094 ms | 79.835 ms | +0.9% |
| Scalar aggregate | 0.0407 ms | 0.0408 ms | +0.3% |
| Web request pipeline | 14.199 ms | 2.850 ms | **-79.9%** |

| Representative release artifact | Before PR | Final | Change |
| --- | ---: | ---: | ---: |
| Vtrace Wasm / gzip | 34,669 / 12,826 B | 34,037 / 12,702 B | -1.8% / -1.0% |
| Scalar aggregate Wasm / gzip | 1,112 / 677 B | 1,112 / 677 B | 0.0% / 0.0% |
| Web pipeline Wasm / gzip | 6,262 / 2,884 B | 3,878 / 1,883 B | **-38.1% / -34.7%** |

The final web lookup stage is 0.644 ms versus 3.245 ms at the PR base (-80.2%),
and serialization is 2.152 versus 11.715 ms (-81.6%). Vtrace now benefits in
release artifact shape from exact iterator/receiver specialization while its
runtime remains effectively flat. Scalar aggregate remains byte-identical.
Without release optimization, Vtrace and scalar aggregate remain byte-identical
to the PR base; the existing proven Array/range codegen paths account for the
non-release web improvement already described above.

## V-479 unmatched controls

The Wasm hash and every recorded instruction-site count are identical before
and after V-479 for both unmatched representative programs, in both modes.
Their small timing movements therefore reflect run-to-run measurement variance
rather than added runtime instructions.

| Scenario | Mode | Compile before -> after | Runtime before -> after | Wasm / gzip |
| --- | --- | ---: | ---: | ---: |
| vtrace | none | 1585.825 -> 1689.906 ms | 401.008 -> 413.823 ms | 166,859 / 42,559 B, identical |
| vtrace | release | 2848.184 -> 2952.175 ms | 81.410 -> 83.195 ms | 34,669 / 12,826 B, identical |
| Scalar aggregate | none | 1236.224 -> 1260.534 ms | 0.169500 -> 0.169750 ms | 37,854 / 9,387 B, identical |
| Scalar aggregate | release | 1438.153 -> 1550.875 ms | 0.037208 -> 0.036959 ms | 1,112 / 677 B, identical |

The focused and web-app modules are also byte- and instruction-identical in
non-release mode. All benchmark runs reported zero linear-memory growth.

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

The intrinsic Array `for` path requires the validated std intrinsic Array
type, the exact standard `for` expansion, and canonical std-owned `iter` and
`next` implementations. It captures the iterable once and reloads count and
storage on every iteration to preserve mutation and reallocation semantics.

General iterator specialization requires the exact standard `for` expansion,
an exact nominal source, a single canonical standard `Sequence.iter` target,
and a fresh concrete nominal object result that resolves to one standard
`Iterator.next` implementation. Generic results use the selected function
instance. The scoped direct-call and receiver facts preserve the normal ABI;
dynamic, ambiguous, noncanonical, or non-fresh paths retain trait dispatch.

Mutable aggregate promotion requires a fresh heap object covered by escape
analysis, a single exact canonical call target, a pure `void` callee, and a
mutable-borrow parameter whose callable-access footprint reads and writes only
known direct fields. The callee cannot retain or return the object, suspend,
perform external access, use runtime identity guards, alias the parameter, or
contain an explicit return. The mutable object must be the first source
argument, and later arguments cannot reference any of its aliases. Eligible
specialization identities are reserved before scalar lanes are installed, so a
budget rejection materializes normally before control flow. Imported targets
and receiver specializations are resolved through the shared eligibility
contract, call-shape variants preserve the lane result, and fallback
materializes every shared alias together. Balanced and non-release builds set
the mutable-lane allowance to zero.

Mutable aggregate promotion directly depends on Voyd's memory-safety work.
Fresh-origin escape facts prove where identity can be observed, while immutable callable
access summaries prove the exact callee cannot hide, retain, or mutate storage
outside the listed fields. Without those contracts, replacing a heap identity
with independent scalar values across a mutable call would be unsound.

## Opportunity decisions

| Opportunity | Decision | Reason |
| --- | --- | --- |
| Stable field loads across calls | Accepted as V-475 | Repeatable 19.8% focused win; the representative loop removes four repeated field-load sites. |
| `Array.get` Option traffic in proven loops | Accepted as V-476 | Repeatable 72.3% focused win and a 78.8% representative route/view-model lookup win. |
| Intrinsic `Range<i32>` iterator traffic | Accepted as V-477 | Restores all-`for` source to all-`while` parity; cuts the incremental integrated pipeline by 44.3%, serialization by 40.1%, and gzip size by 16.7%. |
| Fresh mutable aggregate traffic across exact calls | Accepted as V-479 | Cuts incremental integrated runtime by 44.1%, serialization by 69.4%, and the direct-object focused workload by 90.0%; shrinks representative gzip by 6.5%. |
| Intrinsic `Array<T>` `for` traffic | Accepted | Reaches indexed-loop parity: 95.6% faster in the focused element loop and 91.2% faster in representative view-model serialization. |
| Exact user-iterator dispatch and state traffic | Accepted | Non-intrinsic iterators improve by 84.4% in the light case and 55.7% for filtered/strided traversal; emitted allocation, indirect-call, and iterator field traffic falls to zero. |
| `SharedCell` runtime-check traffic | Deferred | The focused gap was large, but the representative programs had no meaningful use and explicit shared-cell runtime semantics need a separate design decision. |
| Remaining access guards | Stopped | The existing focused guard benchmark measured about 1.34 ns per call, below the threshold for another optimization ticket. |

Each accepted optimization passed focused runtime and emitted-shape tests,
repository tests and typechecking, the test inventory audit, and an independent
review followed by a fresh verification review. V-479 additionally passed
separate completeness, design, and correctness review lenses because it crosses
the scalar-replacement and call-ABI boundaries. The intrinsic Array review
caught and repaired an overbroad macro-lookalike matcher. The general iterator
review caught and repaired missing generic contextual instantiation and missing
post-Binaryen shape coverage before a clean extra-high verification.
