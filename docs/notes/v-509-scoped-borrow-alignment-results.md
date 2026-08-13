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

| Workload | Base | V-509 | Head/base | Peak RSS head/base |
| --- | ---: | ---: | ---: | ---: |
| Borrow depth 8 | 1,041 ms | 1,030 ms | 0.989x | 1.014x |
| Borrow depth 16 | 1,841 ms | 1,829 ms | 0.994x | 0.997x |
| Ordinary topology 8 | 178 ms | 185 ms | 1.035x | 1.000x |
| Ordinary topology 16 | 219 ms | 225 ms | 1.027x | 1.000x |
| Mixed mutation 8 | 503 ms | 514 ms | 1.021x | 1.001x |
| Mixed mutation 16 | 522 ms | 535 ms | 1.024x | 1.001x |

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
