# Memory and mutation safety performance

This report records the V-448 before/after measurements required by
`docs/specs/memory-and-mutation-safety.md`. The comparison uses baseline
`876f1680` and the V-456 working tree after V-451 through V-455.

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

The proposal originally added a substantial compile-time and public-summary
cost. That result is no longer accepted merely because the feature lacked a
threshold. Semantic changes now enter the alternating fresh-process optimizer
scorecard. While V-468 tracks removal of the cold source-analysis regression,
CI retains temporary 45%/250 ms compile and 20%/32 MiB RSS tolerances. A
separate whole-web-package compile must finish within 240 seconds and 4.25 GiB
peak RSS under a 3.5 GiB V8 heap.

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

### Cache lifetime and whole-web remeasurement

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

Measurements below used the same Apple M4 Pro / 48 GiB machine and Node.js
24.18.0. The before revision is `c75466d2`; the after revision is this change.
Each row is a fresh process unless it says same SDK.

| Mode                                  |                              Before |            After |                                      Peak RSS / artifact size |
| ------------------------------------- | ----------------------------------: | ---------------: | ------------------------------------------------------------: |
| Whole-web cold one-shot               |                           66,023 ms | 60,183 ms median |   4,286,939,136 B before; 4,204,691,456–4,303,470,592 B after |
| Focused cold, cache disabled          |                                   — |   1,865–1,895 ms |                                 4,144,676,864–4,236,836,864 B |
| Focused warm, same SDK                |                                   — |       437–446 ms | 4,234,231,808–4,273,405,952 B process peak across cold + warm |
| Focused artifact-seeded fresh process |                 1,003 ms historical |   1,307–1,338 ms |                                 4,218,306,560–4,220,305,408 B |
| Lazy artifact materialization         | 5.8 ms historical eager-export cost |       165–194 ms |                                                   3,051,697 B |

Run the maintained cache-mode benchmark with `npm run
bench:compiler-cache`. The historical artifact timing measured export after
eager artifact work had already happened during compile; the new timing
contains the complete serialization and integrity-hash cost. That work no
longer overlaps codegen unless the caller explicitly exports while another
compile is active.

The cache-disabled whole-web perf trace attributed 1.20 s to graph loading,
54.51 s to semantic analysis, 0.44 s to monomorphization, 0.13 s to
`ProgramCodegenView`, 3.46 s to codegen, and 0.16 s to binary emission. Its
sampled RSS was 4.12 GB after graph loading, 3.21 GB after semantics, 3.24 GB
after monomorphization, 3.26 GB after the codegen view, and 3.36 GB after byte
emission/disposal. The focused cache-enabled trace measured dependency-snapshot
capture at 9.45 ms cold and 5.55 ms warm for 48 modules, 7,153 dependency-arena
types, and 914 borrowing queries.

The four retained whole-web samples were 59,317 ms, 59,414 ms, 60,952 ms, and
61,162 ms. The 60,183 ms median is 8.8% below the baseline. Peak RSS varied by
roughly 100 MB between those runs; the final validation sample was
4,301,062,144 B, effectively the 4,286,939,136 B baseline. No durable cold
peak-RSS win is claimed. The dominant peak remains process/native
initialization plus whole-program semantic state. Delaying Binaryen
initialization until after semantics increased peak RSS to 5,420,761,088 B and
failed the unchanged 4.25 GiB gate, so that experiment was reverted. Explicit
Binaryen disposal is retained because it bounds native lifetime after bytes
are copied, especially across repeated SDK compiles.

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
remains the throughput path. The two dependency-heaviest partition residues are
split into paired sixteenth-partitions after both repeatedly exhausted the
ten-minute process limit. The required whole-package compile gate also keeps
the aggregate package workload visible and fails on timeout, OOM, or RSS-budget
breach.

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
