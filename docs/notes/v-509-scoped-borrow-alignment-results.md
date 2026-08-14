# V-509 Scoped-Borrow Alignment Results

## Fixed budgets and regression gates

These values were recorded before post-change measurements. The exact-call
optimizer keeps its existing safety-independent limits:

- 4,096 analysis operations per exact callable body;
- 64 KiB retained fact data per body; and
- 1 MiB retained exact-call cache data per compile.

The bounded representative run uses these pre-declared gates:

| Workload family                     | Median wall-time limit | Peak RSS limit | Structural limit                                                                                                     |
| ----------------------------------- | ---------------------: | -------------: | -------------------------------------------------------------------------------------------------------------------- |
| Ordinary field and topology scaling |             1.20x base |     1.15x base | Largest two doublings at most 2.25x for summary evaluations, retained summary bytes, and liveness state insertions   |
| Explicit Borrow scaling             |             1.20x base |     1.15x base | No failed source acceptance; parameter-level facts only                                                              |
| Mixed mutation and liveness         |             1.20x base |     1.15x base | Summary evaluations within the finite solver bound; state insertions at most `B * L`; work items at most `B + E * L` |
| Exact-call optimization controls    |             1.10x base |     1.15x base | Per-body and compile-wide budgets remain enforced; exhaustion selects conservative fallback                          |
| Full web and full-stack compile     |             1.20x base |     1.15x base | Required counters present, including explicit zeros                                                                  |

The counter and state bounds are authoritative. Wall time and RSS are
environment-sensitive warning gates that require an explanation when crossed.

## Contract and consumer disposition

- Ordinary safety uses the finite direct, reachable, and ambient modes plus
  reentrant-control and suspension bits.
- Local exclusive capability duration uses current-callable CFG liveness only.
- Package summaries publish no field, index, projection, result, region, or
  implementation-specific path.
- Exact-call optimizer facts remain demand-driven and cannot affect source
  acceptance.
- Identity guards apply only to exact direct/root conflicts. Reachable graph
  overlap never treats unequal root identities as proof of disjointness.
- Existing stable-field forwarding and aggregate-lane consumers retain their
  exact-call owner and conservative materialized fallback.
- Array loop consumers use both direct and reachable finite modes; any write or
  missing summary selects checked access.

## Validation and measurement protocol

Base revision: `1a6319b3` (`Refine scoped borrow safety and performance bounds`).

Hardware, operating-system, Node version, exact revisions, dirty state, source
hashes, samples, warmups, raw phases, counters, runtime values, Wasm sizes, and
peak memory are retained by the JSON benchmark artifacts.

The bounded completion run is:

```sh
npm run bench:v500 -- --families ordinary-fields,ordinary-topology,borrow-calls,borrow-depth,borrow-callbacks,mutation-mixed --sizes 2,4,8,16 --modes none --samples 1 --warmups 0 --fail-on-diagnostics --output /tmp/v509-bounded.json
npm run test:perf
```

The follow-up timing run compares clean base and head checkouts on the same
machine. It alternates revisions, discards one warmup per workload, and records
five fresh-process samples for six focused workloads:

```sh
npm run bench:v500 -- --repo base=/Users/drewy/code/voyd --repo head=/Users/drewy/.codex/worktrees/c695/voyd --scenario borrow-depth-8 --scenario borrow-depth-16 --scenario ordinary-topology-8 --scenario ordinary-topology-16 --scenario mutation-mixed-8 --scenario mutation-mixed-16 --modes none --samples 5 --warmups 1 --fail-on-diagnostics --output /tmp/v509-base-head-compiler.json
```

The representative package-scale run uses one discarded warmup and three
alternating fresh-process samples per revision:

```sh
npm run bench:web-openapi -- --repo base=/Users/drewy/code/voyd --repo head=/Users/drewy/.codex/worktrees/c695/voyd --compiler-cache none --compile-count 1 --warmups 1 --samples 3 --timeout-ms 60000 --require-clean --output /tmp/v509-web-base-head.json
```

## Results

The bounded completion run passed all 24 generated programs on an Apple M4 Pro
(14 logical CPUs, 48 GiB RAM), macOS 26.5, and Node 24.18.0. Cold compile
medians ranged from 145 ms to 1.87 s, and peak RSS ranged from 3.76 GiB to
3.89 GiB. These single-sample values are orientation data rather than a
same-machine base/head comparison.

All six workload families satisfied the finite-summary evaluation bound and
both local-liveness bounds. The ordinary topology series grew from 34 to 66
summary evaluations and from 80 to 160 liveness state insertions between the
largest two input sizes, remaining at or below the declared 2.25x structural
gate. The mixed mutation series grew from 376 to 400 summary evaluations and
from 1,061 to 1,333 liveness state insertions. Exact-call budget-exhaustion and
fallback counters were explicitly present and zero in this workload set.

The repeated focused comparison produced these compile-time medians:

| Workload             |     Base |    V-509 | Head/base | Peak RSS head/base |
| -------------------- | -------: | -------: | --------: | -----------------: |
| Borrow depth 8       | 1,041 ms | 1,030 ms |    0.989x |             1.014x |
| Borrow depth 16      | 1,841 ms | 1,829 ms |    0.994x |             0.997x |
| Ordinary topology 8  |   178 ms |   185 ms |    1.035x |             1.000x |
| Ordinary topology 16 |   219 ms |   225 ms |    1.027x |             1.000x |
| Mixed mutation 8     |   503 ms |   514 ms |    1.021x |             1.001x |
| Mixed mutation 16    |   522 ms |   535 ms |    1.024x |             1.001x |

The borrowing phase was 5% to 16% slower across these workloads. Its absolute
increase was small: the largest ordinary-mutation increase was 1.72 ms. Total
compile time ranged from 1.1% faster to 3.5% slower, and peak RSS ranged from
0.3% lower to 1.4% higher.

The earlier 1.75x borrow-depth timing signal is present in both revisions. The
8-to-16 compile ratio was 1.768x on base and 1.775x on V-509 while summary and
liveness work remained constant. The ordinary-topology ratios were 1.227x on
base and 1.218x on V-509; mixed mutation was 1.038x and 1.042x. The comparison
therefore gives no evidence that V-509 worsens asymptotic scaling.

`npm run test:perf` passed eight tests with one intentionally skipped test.

The Web/OpenAPI package-scale comparison measured a 24,244 ms base compiler
median and a 24,537 ms V-509 median, a 1.012x ratio. Process wall time was
1.011x and peak RSS was 0.968x. Borrow analysis rose from 1,178 ms to 1,249 ms
(1.060x), remaining 5.1% of total compiler time. Ordinary mutation analysis
rose from 127 ms to 137 ms (1.084x).

The package-scale finite solver used 7,260 of its 139,458 evaluation bound
(5.2%). Liveness recorded 10,949 state insertions against a `B * L` bound of
2,854,698 (0.38%), and 12,891 work items against a `B + E * L` bound of
2,924,806 (0.44%). No widening or full-fact materialization occurred. These
results support the intended finite, bounded scaling model while leaving ample
headroom in the production assertions.

## Follow-up performance ownership

JSON and MessagePack recursive serialization now use private reverse-linked
byte sinks and reconstruct contiguous storage once at completion. This avoids
claiming detached result provenance that V-509 does not define, but it allocates
one node per emitted byte. A future detached/fresh result contract should own
recovering contiguous mutable builders without weakening source safety.

### Standard-library migration cost ledger

The following costs remain after the source-level cleanup in V-509. They are
correctness-preserving fallbacks, not intended collection or codec designs:

| Area                                      | Current cost                                                                                                                                                                         | Why V-509 cannot safely undo it                                                                                                                                                                                                                                                                                                                                                                 | Smallest follow-up remedy                                                                                                                                          |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| HTTP request buffering                    | `RequestBody.read_all` reads and pushes each byte instead of using the existing bulk `ByteBuffer.extend` path.                                                                       | V-509 does not publish a detached result or representation-disjointness fact for the returned request chunk and the buffer storage.                                                                                                                                                                                                                                                             | Use the V-504 detached/fresh result investigation to make the overlap-safe bulk-copy contract visible at the call.                                                 |
| JSON output                               | Each emitted byte allocates one reverse-link node and performs a checked `SharedCell` mutation; completion traverses all nodes into contiguous storage.                              | Mutating an `Array` stored inside the borrowed `SharedCell` state is rejected because the nested storage relationship is not expressible in the finite summary.                                                                                                                                                                                                                                 | Provide a scoped contiguous builder whose private storage cannot escape, or an equivalent bounded representation contract.                                         |
| MessagePack output                        | The byte sink has the same per-byte node allocation, checked mutation, and final traversal as JSON.                                                                                  | The same nested-storage limitation applies.                                                                                                                                                                                                                                                                                                                                                     | Share the V-504 builder/result contract with JSON.                                                                                                                 |
| JSON parser and MessagePack codec cursors | Cursor reads and updates use `SharedCell`, including runtime borrow checks and callback calls on hot per-token or per-byte paths.                                                    | Recursive helpers can no longer retain an ordinary mutable cursor across reference-bearing call results under V-509's conservative result-alias rule.                                                                                                                                                                                                                                           | Express same-place or detached results in V-504, then return these cursors to ordinary scoped mutation.                                                            |
| MessagePack `DataValue` encoding          | Encoding first constructs an intermediate recursive `MsgPack` tree. `DataBytes` additionally copies `Bytes` into an `Array`, and variant entry finalization copies its entries once. | Direct recursive writing keeps a mutable writer live while traversing a reference-bearing input tree.                                                                                                                                                                                                                                                                                           | Use the scoped builder/result contract to restore direct streaming into `MsgPackWriter`.                                                                           |
| MessagePack `DataValue` decoding          | The immutable input is copied with an element loop before constructing a mutable reader. The old path also copied once, but used the bulk `ByteBuffer.extend` operation.             | The detached relationship between decoded values, reader state, and the input bytes is not represented.                                                                                                                                                                                                                                                                                         | Restore the bulk path once V-504 can state the required detached result relationship.                                                                              |
| JSON and MessagePack map construction     | JSON object parsing/conversion and MessagePack unpacking/decoding still use persistent `Dict.setting`, copying dictionary structure for each entry.                                  | Source entries, parser values, or decoder results may retain reference-bearing values, and V-509 cannot prove them disjoint from the mutable destination across the call.                                                                                                                                                                                                                       | Use V-504 result relationships to authorize the phased mutable destination after each source result is complete.                                                   |
| Set updates                               | `inserting` and `removing` remain the only update APIs and copy dictionary structure per operation.                                                                                  | Although mutable `Dict.set` is restored, a generic mutable wrapper cannot yet forward its `self`, key, and value handles to another mutable collection call. `Dict.insert` has a scalar result and could be restored by duplicating the complete mutation body, but that would leave two hash-table implementations to maintain. `Dict.remove` additionally returns a reference-bearing result. | Investigate a bounded checked-forwarding contract for collection wrappers; use V-504's result-relationship work for `remove`, then restore mutable Set forwarding. |
| Neutral `DataValue` event construction    | The linear sink allocates one reverse-link node per event and materializes contiguous storage once.                                                                                  | A mutable recursive `Array` accumulator has the same unexpressed builder/input relationship.                                                                                                                                                                                                                                                                                                    | Replace the private sink with the shared scoped builder when that contract exists.                                                                                 |

Two source-level costs were repaired within V-509 without new result semantics:

- `Dict.set` again mutates only the affected bucket, except when growth requires
  rehashing, instead of copying the complete bucket table for every update;
- neutral `DataValue` event construction no longer performs repeated
  `Array.pushed` and `Array.extended` prefix copies; its construction is linear;
- temporary MessagePack arrays and field lists use local in-place `push` instead
  of copying their complete prefix for each appended value; and
- path joining fills one exactly sized fixed array locally instead of creating
  intermediate strings through chained concatenation.
