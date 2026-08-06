# Memory and mutation safety performance

This report records the V-448 before/after measurements and subsequent
performance work for the memory-and-mutation-safety implementation. The
comparison uses baseline `876f1680` and the V-456 working tree after V-451
through V-455.

## Method

- Machine: Apple M4 Pro, 14 logical CPUs, 48 GiB RAM, macOS arm64
- Runtime: Node.js 24.18.0
- Fixture: `tests/performance/fixtures/scalar-aggregate-representative.voyd`
- Modes: unoptimized (`none`) and optimized (`release`)
- Compile samples: 7, with a fresh SDK instance for each sample
- Runtime samples: 11 after 3 warmups, all with the checksum
  `1_100_340_000`
- Allocation signals: generated Wasm GC allocation instruction sites and
  linear-memory growth across repeated execution
- Summary size: total serialized bytes retained in public module snapshots;
  serialization work is recorded separately
- Guard cost: paired medians for 10,000 dynamically guarded and statically
  disjoint calls in one compiled module

Run the benchmark with:

```sh
npm run bench:memory-safety -- \
  --repo /path/to/voyd \
  --fixture-repo /path/to/voyd \
  --label revision \
  --samples 7 \
  --runtime-samples 11
```

To measure another revision without switching the working tree, export that
revision to a temporary directory, install its workspace dependencies, and
pass that directory to `--repo`. `--fixture-repo` remains the current tree so
the focused guard fixture is identical.

## Results

| Dimension                         | Mode    |           `876f1680` |       V-456 |                  Delta |
| --------------------------------- | ------- | -------------------: | ----------: | ---------------------: |
| Compile wall time, median         | none    |            907.00 ms |  1731.94 ms |   +824.94 ms (+90.95%) |
| Compile wall time, median         | release |           1108.87 ms |  1933.97 ms |   +825.10 ms (+74.41%) |
| Runtime, median                   | none    |          0.180709 ms | 0.185291 ms |  +0.004582 ms (+2.54%) |
| Runtime, median                   | release |          0.036042 ms | 0.040458 ms | +0.004416 ms (+12.25%) |
| Retained public-summary size      | both    | no serialized format | 1,431,501 B |           +1,431,501 B |
| Summary serialization work        | both    | no serialized format | 1,341,558 B |           +1,341,558 B |
| Generated allocation sites        | none    |                  997 |         939 |           -58 (-5.82%) |
| Generated allocation sites        | release |                    5 |           5 |                      0 |
| Repeated-run linear-memory growth | both    |                  0 B |         0 B |                    0 B |
| Generated Wasm size               | none    |             39,575 B |    37,821 B |      -1,754 B (-4.43%) |
| Generated Wasm size               | release |              1,112 B |     1,112 B |                    0 B |
| Runtime identity comparisons      | both    |                    0 |           0 |                      0 |

The runtime numbers are below one millisecond, so their small percentage
changes are timing-noise sensitive. The important runtime signals are that the
checksum is unchanged, optimized and unoptimized results agree, ordinary code
contains no identity guards, and repeated execution does not grow linear
memory.

## Runtime guard cost

The baseline rejected the focused dynamic-place program, because the bounded
fallback did not exist. V-456 accepts it in both modes and retains two
identity-comparison sites in the whole fixture module.

| Mode    | Guarded median, 10,000 calls | Static median, 10,000 calls | Median guard delta | Per guarded call |
| ------- | ---------------------------: | --------------------------: | -----------------: | ---------------: |
| none    |                  0.113834 ms |                 0.104625 ms |        0.009209 ms |          0.92 ns |
| release |                  0.053459 ms |                 0.039584 ms |        0.013875 ms |          1.39 ns |

The guard is call-scoped: successful calls allocate no persistent loan state,
static conflicts remain compile errors, statically disjoint places omit the
guard, and equal runtime identities produce the required deterministic panic.

## Assessment

The implementation originally added a substantial compile-time and
public-summary cost. That result is no longer accepted merely because the
feature lacked a threshold. Semantic changes now enter the alternating
fresh-process optimizer scorecard. While V-468 tracks removal of the cold
source-analysis regression, CI retains temporary 45%/250 ms compile and 20%/32
MiB RSS tolerances. A separate whole-web-package compile must finish within 240
seconds and 4.25 GiB peak RSS under a 3.5 GiB V8 heap.

Runtime and generated-code costs remain bounded:

- ordinary code has no guard or persistent loan bookkeeping;
- optimized allocation sites and Wasm size are unchanged from the baseline;
- unoptimized allocation sites and Wasm size improve;
- the dynamically uncertain path pays about 1.4 ns per guarded call in this
  focused benchmark;
- all guard and ordinary-value behavior is checked in both build modes.

Package-scale performance work is tracked by
[V-462](https://linear.app/voyd-lang/issue/V-462). It must preserve the public
summary schema and `ProgramCodegenView` boundary.

## Source-compilation behavior

Fresh SDK instances still load and type the standard library from source.
Borrow analysis for unchanged dependencies can be restored from the versioned
`voyd.compiler-dependency-borrow-cache` artifact without restoring a
compiler-private type arena or `SemanticsPipelineResult`. Against the original V-448 baseline medians of 907.00 ms
unoptimized and 1,108.87 ms in release mode, the later seven-sample source
measurements were 2,097.13 ms and 2,513.49 ms respectively: 131.22% and 126.67%
slower. The source-analysis regression remains the representative cold-compile
behavior for default-prelude, package-heavy, and test-enabled workflows.

A reused SDK instance keeps the optional compiler-private typing/codegen
snapshot in process. Across processes, callers can persist
`sdk.exportCompilerArtifact()` and pass it to
`createSdk({ compilerArtifact })`. Per-module source fingerprints and reverse
dependency invalidation select reusable borrowing results; exact in-process
query inputs and SHA-256-compacted persisted inputs/dependency outputs handle
edits within a recomputed module. Public
exports use a separate `voyd.package-semantic-interface` contract table, so
re-exports reference canonical summary ids instead of owning another summary.

On the report machine, a JSON-round-tripped artifact reduced the focused fresh
SDK compile from 1,967 ms to 1,003 ms (49.0%); exporting it took 5.8 ms and the
artifact was 3.05 MB. This is
the supported durable boundary. The removed 5.2 MB full semantic snapshot is
not restored as a package ABI.

### Cache lifetime

The SDK now makes cache retention explicit:

```ts
const oneShot = createSdk({ compilerCache: "none" });
const incremental = createSdk({ compilerCache: "memory" }); // default
```

`none` skips dependency-snapshot capture and cannot export a compiler artifact.
The default remains `memory` for compatibility and for watch, language-server,
and repeated SDK workloads. In-memory snapshot commit transfers the already
isolated dependency clone into the cache instead of cloning it a second time.
Borrow-artifact serialization is deferred until `exportCompilerArtifact()`.

The cache-disabled whole-web gate had a 60.2-second median after this change,
down from 66.0 seconds. Peak RSS remained approximately 4.29 GB, so this work
does not claim a cold-memory reduction.

## Hosted CI impact

The feature's package-heavy compilations also affected hosted CI. These are the
durable measurements behind the temporary limits documented in the
[CI guide](./ci.md):

| Area        | Observed impact                                                                                                                                                                                |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tooling     | `bootstrap.test.ts` reached 208,119 ms and `project.test.ts` reached 190,624 ms.                                                                                                               |
| SDK/core    | The web-helper test reached 260,705 ms, `sdk-node.test.ts` reached 349,978 ms, and the affected core command reached 523,746 ms.                                                               |
| Integration | Repeated V-448 runs reached 442,938–532,981 ms wall; the slowest VX DOM sample was 348,433 ms. The temporary hard limits are 600,000 ms wall and 390,000 ms for VX DOM.                        |
| Web package | The monolithic compile exhausted a 4.06 GiB heap after 188.8 seconds and still failed with a 6 GiB heap after 212.4 seconds. Per-file isolation bounded memory but left a 27:42 critical path. |

Compile-level eight-way web partitioning reduced the subsequent hosted workflow
from 27:42 in [run 30611360104](https://github.com/voyd-lang/voyd/actions/runs/30611360104)
to 7:07 in
[run 30661296540](https://github.com/voyd-lang/voyd/actions/runs/30661296540).
All 19 jobs passed; individual web partitions completed in 2:43–6:07. Sharding
remains the throughput path. The two dependency-heaviest partition residues
were temporarily split further after both repeatedly exhausted the ten-minute
process limit. Query-scoped aggregate-origin memoization subsequently reduced
the pathological response-overrides fact scan by about 90%. All four recombined
CI partitions then passed locally in 45–100 seconds, allowing the matrix to
contract from twelve jobs to four. The required whole-package compile gate also
keeps the aggregate package workload visible and fails on timeout, OOM, or
RSS-budget breach.

Removal of every temporary performance allowance is tracked exclusively by
[V-468](https://linear.app/voyd-lang/issue/V-468).

## V-472 architecture repair result

V-472 replaced the overlapping rich-summary passes with one callable-fact
boundary, a declared-contract-seeded SCC solve, post-solve contract validation,
and loan checking over the same facts and compact callee contracts. It also
removed compiler-internal rich-summary encoding and decoding. The final
production compiler diff is 875 lines smaller (7,359 additions and 8,234
deletions), including the new fact representation.

The implementation did not meet the source-performance completion gate. The
final comparison used seven alternating fresh Node processes for each revision
and mode. Each fresh process compiled std from source. Raw samples and
machine-readable counters are in
[`v472-source-benchmark.json`](./v472-source-benchmark.json).

| Seven-sample source median |  `876f1680` | PR `1488efd4` | V-472 working tree |    V-472 vs baseline |        V-472 vs PR |
| -------------------------- | ----------: | ------------: | -----------------: | -------------------: | -----------------: |
| Unoptimized                | 1,373.20 ms |   2,112.87 ms |        2,070.98 ms | +697.78 ms (+50.81%) | -41.88 ms (-1.98%) |
| Release                    | 1,919.76 ms |   2,659.35 ms |        2,617.76 ms | +698.00 ms (+36.36%) | -41.59 ms (-1.56%) |

The implementation reduced effective detailed contract analysis from
1,015/1,052 callables on the PR to 762/887, checked 395 bodies for conflicts,
performed 783 contract evaluations, and admitted 176 callables to the compact
fast path. It performed zero internal summary decodes (down from 696) and
retained 1,408,914 bytes of compact contracts. Borrow analysis still took
about 672 ms: approximately 262 ms for fact extraction, 254 ms for contract
inference, and 142 ms for loan checking. That remaining source cost exceeds
both V-472 gate thresholds.

Current Wasm is byte-identical to PR `1488efd4` in both modes. The cold source
regression remains above both V-472 completion thresholds.

The focused runtime/allocation check retained zero repeated-run linear-memory
growth. Unoptimized current runtime was 0.183959 ms versus 0.186250 ms at the
baseline, with 939 versus 997 generated allocation sites. Release runtime was
0.042125 ms versus 0.043416 ms, with five allocation sites at both revisions.
Runtime guards remained supported and bounded.

## V-473 owned-result provenance result

V-473 publishes a projection-aware result-provenance summary before capability
routing. Owned aggregate results and safe wrappers can now take the no-analysis
or transient paths, while parameter, module, external, mixed, unresolved, and
depth-widened results remain conservative. The callable index and transient
contract composer consume the published fact and do not perform provenance
analysis themselves.

The final source comparison used seven alternating fresh Node processes for
each revision and mode. Each fresh process compiled std from source. Raw samples
and machine-readable routing, work, memory, and Wasm measurements are in
[`v473-source-benchmark.json`](./v473-source-benchmark.json).

| Seven-sample source median | PR head `15077084` |         V-473 |             Change |
| -------------------------- | -----------------: | ------------: | -----------------: |
| Unoptimized compile        |        2,049.82 ms |   2,106.16 ms | +56.34 ms (+2.75%) |
| Release compile            |        2,620.68 ms |   2,675.32 ms | +54.63 ms (+2.08%) |
| Unoptimized peak heap      |      680,139,560 B | 666,047,048 B |             -2.07% |
| Release peak heap          |      698,993,864 B | 691,122,992 B |             -1.13% |
| Unoptimized RSS growth     |      128,794,624 B | 133,693,440 B |             +3.80% |
| Release RSS growth         |      157,319,168 B | 164,184,064 B |             +4.36% |

Routing moved 32 of 481 callables off the flow-sensitive tier: no-analysis
callables increased from 287 to 305 and transient callables from 119 to 133.
Materialized full-fact blocks fell from 3,114 to 3,012 and operations from
18,490 to 18,266. Full-contract evaluations increased from 531 to 541;
compact evaluations increased from 827 to 1,118 as more callables entered
compact routing. The bounded provenance pass cost about 32 ms, and retained
contract bytes increased from 1,487,881 to 1,502,816 because owned field
projections are now preserved across module contracts.

Unoptimized and release Wasm are byte-identical to the PR head. Focused
regressions cover local and cross-module aggregate projections, module aliases,
recursive wrappers, runtime-checked wrappers, and projected-local reference
escapes. The complete monorepo suite passes, and the std source lane completes
under the default heap.

## Current pre-PR comparison

The comparison at `34f22a6f` reran the original `876f1680` baseline on Node
24.18.0 and the same Apple M4 Pro host. The source compiler result uses seven
alternating fresh Node processes for each revision and mode. It supersedes the
earlier intermediate PR measurements above.

| Seven-sample source median | `876f1680` | `34f22a6f` | Change |
| -------------------------- | ---------: | ---------: | -----: |
| Unoptimized compile | 1,295.67 ms | 1,898.31 ms | +602.64 ms (+46.51%) |
| Release compile | 1,827.99 ms | 2,438.51 ms | +610.52 ms (+33.40%) |
| Unoptimized borrow analysis | 161.34 ms | 596.39 ms | +435.05 ms (+269.65%) |
| Release borrow analysis | 164.00 ms | 603.98 ms | +439.98 ms (+268.28%) |
| Unoptimized peak heap | 556,683,776 B | 660,891,976 B | +18.72% |
| Release peak heap | 624,833,576 B | 678,272,144 B | +8.55% |
| Unoptimized process max RSS | 4,188,700,672 B | 4,219,355,136 B | +0.73% |
| Release process max RSS | 4,239,097,856 B | 4,256,628,736 B | +0.41% |

The focused scalar-aggregate benchmark shows a larger compile regression:
945.50 to 1,552.44 ms unoptimized (+64.19%) and 1,140.51 to 1,755.51 ms in
release (+53.92%). Runtime medians changed from 0.1872 to 0.1946 ms
unoptimized and 0.0403 to 0.0409 ms in release. These sub-millisecond deltas
remain timing-noise sensitive. Repeated-run linear-memory growth stayed at
zero. Unoptimized generated allocation sites fell from 997 to 939 and Wasm
size fell 4.35%; both release signals were unchanged. The new dynamic fallback
cost about 1.0 ns per guarded call unoptimized and 1.8 ns in release.

A fresh cold whole-Web compile remains the scale outlier. One controlled sample
increased from 23.31 seconds to 62.12 seconds (+166.44%). Peak RSS in that pair
fell from 4,297,015,296 to 4,147,773,440 bytes (-3.47%), and emitted Wasm size
fell 10.75%. The compile-time result is consistent with the existing
60.2-second current median, while the single-sample RSS comparison is
directional rather than a new memory median.

The remaining source delta is concentrated in memory-safety analysis: it adds
about 435–440 ms to the representative compile while the complete compile adds
about 603–611 ms. Package-scale compilation amplifies that cost further. The
next performance work should therefore reduce conservative contract/provenance
propagation and make the final local checker consume bounded authoritative
facts; the aggregate-origin repair does not replace either architectural step.

## Authoritative dispatch and local-checker repair

This change makes declared trait contracts authoritative at dynamic-dispatch
boundaries and narrows the final body checker to prepared, immutable borrowing
facts. Call resolution, dependency projection, and storage classification now
happen before that checker runs. Bodies are checked sequentially so each
body-specific context can be released after its diagnostics and optional debug
detail have been collected.

The representative source comparison used seven alternating fresh Node
processes per revision and mode. `630b8d6c` is the immediate before revision;
`876f1680` is the original memory-safety baseline.

| Seven-sample source median | `876f1680` | `630b8d6c` | Current | Current vs before | Current vs baseline |
| -------------------------- | ---------: | ---------: | ------: | ----------------: | ------------------: |
| Unoptimized compile | 1,324.48 ms | 1,968.63 ms | 1,950.05 ms | -18.58 ms (-0.94%) | +625.57 ms (+47.23%) |
| Release compile | 1,856.71 ms | 2,499.45 ms | 2,483.59 ms | -15.86 ms (-0.63%) | +626.88 ms (+33.76%) |
| Unoptimized peak heap | 541,518,792 B | 650,779,464 B | 666,136,208 B | +2.36% | +23.01% |
| Release peak heap | 605,141,224 B | 680,008,912 B | 684,720,584 B | +0.69% | +13.15% |
| Unoptimized process max RSS | 4,182,294,528 B | 4,225,531,904 B | 4,224,630,784 B | -0.02% | +1.01% |
| Release process max RSS | 4,229,054,464 B | 4,255,891,456 B | 4,255,744,000 B | effectively flat | +0.63% |

Peak heap is the largest JavaScript heap observed during compilation. Maximum
RSS is the operating system's peak resident-memory reading for the process.
Process RSS remained flat relative to the immediate before revision. Because
the benchmark compares complete revisions, it does not isolate the effect of
sequential body disposal or demonstrate a peak-memory reduction.

The checker workset stayed bounded: 449 of 887 body callables were checked and
699 public contracts retained 1,012,550 bytes in both revisions. Compact
contract evaluations fell from 1,118 to 1,113. Result classification became
more precise: unknown results fell from 268 to 258, parameter-derived results
rose from 19 to 27, and mixed results rose from 45 to 47. Wasm output is
byte-identical to `630b8d6c` in both modes.

The focused scalar benchmark independently measured a 1,318.28 ms
unoptimized median and a 1,480.36 ms release median, versus 1,408.60 ms and
1,564.37 ms at `630b8d6c`. Its contract-computation median fell from 349.20 to
325.47 ms unoptimized and from 329.97 to 321.34 ms in release. Loan checking
fell from 113.95 to 111.34 ms and from 106.32 to 100.57 ms respectively.
Runtime, allocation sites, retained-contract size, and generated Wasm size were
unchanged within measurement noise. Dynamic guard overhead remained about
1.0 ns per guarded call unoptimized and 1.6 ns in release.

A cold whole-Web compile completed in 66.84 seconds with a 4,308,189,184-byte
maximum RSS and a 1,045,057-byte Wasm module, within the existing package gate.
Recovering declared result origins at trait boundaries added roughly 2.2--2.6
seconds to the result-provenance phase in repeated whole-Web samples. This is a
deliberate precision cost at the package-scale outlier; the overall gate still
passes, and the representative source benchmark improved slightly. Performance
counters now attribute unknown provenance to causes such as an ambiguous call,
missing result origin, unsupported expression, or the bounded depth limit.
