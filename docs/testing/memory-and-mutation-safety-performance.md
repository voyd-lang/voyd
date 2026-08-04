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

The proposal adds a substantial compile-time and snapshot-size cost. That cost
comes from whole-program borrow analysis plus versioned, privacy-preserving
callable summaries for std and user modules. It is explicit and accepted for
this proposal because it buys separate-compilation safety across traits,
generics, wrappers, effects, defaults, and re-exports; the completion gate has
no regression threshold for these new capabilities.

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

## Precompiled std snapshot

The V-448 branch ships a compiler-ABI-versioned precompiled semantic snapshot
for the 48 std modules reachable from the default prelude. The final-head
confirmation below was run on 2 August 2026 against compiler and artifact
revision `d139047f`. Each sample launches a new Node process, creates a new SDK,
compiles the representative fixture, and exits. Source mode sets
`VOYD_DISABLE_PRECOMPILED_STD_SNAPSHOT=1`. Both paths emit identical Wasm:
37,854 bytes unoptimized
(`85c607b9c5ce04d556c66fa1f1a0f7c46182685d87fc19a6c7ff740c6fd0fd7d`)
and 1,112 bytes in release mode
(`82ffc2152a22bd82a6e2ef939add5d5a8d17ccc28de80b80dd8d6c588a421710`).

| Compile wall time, 7-sample median | Mode    | Source analysis | Precompiled std |                  Delta |
| ---------------------------------- | ------- | --------------: | --------------: | ---------------------: |
| Fresh process                      | none    |     2,097.13 ms |       697.78 ms | -1,399.36 ms (-66.73%) |
| Fresh process                      | release |     2,513.49 ms |     1,101.20 ms | -1,412.29 ms (-56.19%) |

The checked-in hybrid artifact is 5,239,953 bytes. It includes both the
canonical portable reference graph and the optional Node/V8 accelerator.
Median snapshot loading, including source-manifest verification, decompression,
identity restoration, and validation, takes 282.48 ms unoptimized and 283.96 ms
in release mode. Compiler performance counters prove the hit loads 48
precompiled graph modules and performs no `graph.load_module.std` work.
Semantic analysis then recomputes only the application module.

Reproduce this comparison with:

```sh
npm run bench:precompiled-std -- 7
```

The original 350–500 ms whole-compile goal is not reachable with the current
whole-program codegen and compiler-private snapshot shape. Restoring the
complete HIR/typing/binding object graph accounts for roughly 0.28 seconds.
Against the original V-448 baseline medians of 907.00 ms and 1,108.87 ms,
final-head source analysis is 131.22% slower unoptimized and 126.67% slower in
release mode. Snapshot-hit compilation is 23.07% faster unoptimized and 0.69%
faster in release mode. The snapshot recovers the representative default-
prelude path, but package-heavy and snapshot-miss paths retain the source-
analysis regression. Smaller public package contracts, incremental callable
analysis, persistent caches, and reusable dependency codegen are tracked under
[V-462](https://linear.app/voyd-lang/issue/V-462).

## Hosted CI impact

The feature's package-heavy compilations also affected hosted CI. These are the
durable measurements behind the temporary limits documented in the
[CI guide](./ci.md):

| Area | Observed impact |
| --- | --- |
| Tooling | `bootstrap.test.ts` reached 208,119 ms and `project.test.ts` reached 190,624 ms. |
| SDK/core | The web-helper test reached 260,705 ms, `sdk-node.test.ts` reached 349,978 ms, and the affected core command reached 523,746 ms. |
| Integration | A healthy run reached 394,740 ms wall; its slowest files were VX DOM at 256,162 ms, Wasm validation at 106,437 ms, and web framework at 91,427 ms. |
| Web package | The monolithic compile exhausted a 4.06 GiB heap after 188.8 seconds and still failed with a 6 GiB heap after 212.4 seconds. Per-file isolation bounded memory but left a 27:42 critical path. |

Compile-level eight-way web partitioning reduced the subsequent hosted workflow
from 27:42 in [run 30611360104](https://github.com/voyd-lang/voyd/actions/runs/30611360104)
to 7:07 in
[run 30661296540](https://github.com/voyd-lang/voyd/actions/runs/30661296540).
All 19 jobs passed; individual web partitions completed in 2:43–6:07. This
fixes feedback latency and memory isolation, but it does not remove the
underlying package-analysis costs above.

Removal of every temporary performance allowance is tracked exclusively by
[V-468](https://linear.app/voyd-lang/issue/V-468).

## V-472 architecture repair result

V-472 replaced the overlapping rich-summary passes with one callable-fact
boundary, a declared-contract-seeded SCC solve, post-solve contract validation,
and loan checking over the same facts and compact callee contracts. It also
removed compiler-internal rich-summary encoding and decoding. The final
production compiler diff is 875 lines smaller (7,359 additions and 8,234
deletions), including the new fact representation.

The reviewed implementation did not meet the source-performance completion
gate and therefore was not committed or pushed. The final comparison used
seven alternating fresh Node processes for each revision and mode, with the
precompiled std snapshot disabled. Raw samples and machine-readable counters
are in [`v472-source-benchmark.json`](./v472-source-benchmark.json).

| Seven-sample source median | `876f1680` | PR `1488efd4` | V-472 working tree | V-472 vs baseline | V-472 vs PR |
| --- | ---: | ---: | ---: | ---: | ---: |
| Unoptimized | 1,373.20 ms | 2,112.87 ms | 2,070.98 ms | +697.78 ms (+50.81%) | -41.88 ms (-1.98%) |
| Release | 1,919.76 ms | 2,659.35 ms | 2,617.76 ms | +698.00 ms (+36.36%) | -41.59 ms (-1.56%) |

The implementation reduced effective detailed contract analysis from
1,015/1,052 callables on the PR to 762/887, checked 395 bodies for conflicts,
performed 783 contract evaluations, and admitted 176 callables to the compact
fast path. It performed zero internal summary decodes (down from 696) and
retained 1,408,914 bytes of compact contracts. Borrow analysis still took
about 672 ms: approximately 262 ms for fact extraction, 254 ms for contract
inference, and 142 ms for loan checking. That remaining source cost exceeds
both V-472 gate thresholds.

Current Wasm is byte-identical to PR `1488efd4` in both modes. A separate
seven-sample snapshot/source run measured 699.02 ms snapshot versus 2,033.71 ms
source unoptimized, and 1,083.71 ms versus 2,410.56 ms release. Snapshot hits
are below baseline source time, but do not make the source regression
acceptable. The snapshot was intentionally left stale rather than regenerated
over a failing source architecture.

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
each revision and mode, with the precompiled std snapshot disabled. Raw samples
and machine-readable routing, work, memory, and Wasm measurements are in
[`v473-source-benchmark.json`](./v473-source-benchmark.json).

| Seven-sample source median | PR head `15077084` | V-473 | Change |
| --- | ---: | ---: | ---: |
| Unoptimized compile | 2,049.82 ms | 2,106.16 ms | +56.34 ms (+2.75%) |
| Release compile | 2,620.68 ms | 2,675.32 ms | +54.63 ms (+2.08%) |
| Unoptimized peak heap | 680,139,560 B | 666,047,048 B | -2.07% |
| Release peak heap | 698,993,864 B | 691,122,992 B | -1.13% |
| Unoptimized RSS growth | 128,794,624 B | 133,693,440 B | +3.80% |
| Release RSS growth | 157,319,168 B | 164,184,064 B | +4.36% |

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
escapes. The regenerated std snapshot and the complete monorepo suite pass;
the std source lane completes under the default heap.
