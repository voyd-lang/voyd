# V-509 Scoped-Borrow Alignment Results

## Fixed budgets and regression gates

These values were recorded before post-change measurements. The exact-call
optimizer keeps its existing safety-independent limits:

- 4,096 analysis operations per exact callable body;
- 64 KiB retained fact data per body; and
- 1 MiB retained exact-call cache data per compile.

The bounded representative run uses these pre-declared gates:

| Workload family | Median wall-time limit | Peak RSS limit | Structural limit |
| --- | ---: | ---: | --- |
| Ordinary field and topology scaling | 1.20x base | 1.15x base | Largest two doublings at most 2.25x for summary evaluations, retained summary bytes, and liveness state insertions |
| Explicit Borrow scaling | 1.20x base | 1.15x base | No failed source acceptance; parameter-level facts only |
| Mixed mutation and liveness | 1.20x base | 1.15x base | Summary evaluations within the finite solver bound; state insertions at most `B * L`; work items at most `B + E * L` |
| Exact-call optimization controls | 1.10x base | 1.15x base | Per-body and compile-wide budgets remain enforced; exhaustion selects conservative fallback |
| Full web and full-stack compile | 1.20x base | 1.15x base | Required counters present, including explicit zeros |

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

The full same-machine base/head matrix remains available through
`npm run bench:v500 -- --list-workloads`. V-509 completion does not block on
that full matrix unless the bounded run exposes a correctness or scaling defect.

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

The largest adjacent timing increase was 1.75x for borrow-depth from size 8 to
16 while its summary evaluations, retained summary bytes, and liveness state
insertions remained constant. Because the run uses one sample and has no base
comparison, this is recorded as a timing signal rather than a V-509 blocker.
`npm run test:perf` passed eight tests with one intentionally skipped test.

The Web/OpenAPI compile gate also passed after the breaking standard-library
migration: 25.0 s compile time, 4.14 GB maximum RSS, and a 1,933,383-byte Wasm
binary.

## Follow-up performance ownership

JSON and MessagePack recursive serialization now use private reverse-linked
byte sinks and reconstruct contiguous storage once at completion. This avoids
claiming detached result provenance that V-509 does not define, but it allocates
one node per emitted byte. A future detached/fresh result contract should own
recovering contiguous mutable builders without weakening source safety.
