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

Future work may reduce analysis latency or deduplicate snapshot payloads, but
doing so must preserve the public summary schema and `ProgramCodegenView`
boundary.

## Precompiled std follow-up

The V-448 branch now ships a compiler-versioned precompiled semantic snapshot
for the 48 std modules reachable from the default prelude. Each sample below
launches a new Node process, creates a new SDK, compiles the representative
fixture, and exits. Source mode sets
`VOYD_DISABLE_PRECOMPILED_STD_SNAPSHOT=1`. Both paths emit identical Wasm:
37,821 bytes unoptimized and 1,112 bytes in release mode.

| Compile wall time, 7-sample median | Mode    | Source analysis | Precompiled std |                  Delta |
| ---------------------------------- | ------- | --------------: | --------------: | ---------------------: |
| Fresh process                      | none    |     1,999.90 ms |       694.79 ms | -1,305.11 ms (-65.26%) |
| Fresh process                      | release |     2,440.59 ms |     1,077.15 ms | -1,363.44 ms (-55.86%) |

The checked-in artifact is 1,783,978 bytes. On a representative fresh load,
source-manifest verification, decompression, identity restoration, and
validation take about 280 ms. Compiler performance counters prove the hit loads
48 precompiled graph modules and performs no `graph.load_module.std` work.
Semantic analysis then recomputes only the application module.

The original 350–500 ms whole-compile goal is not reachable with the current
whole-program codegen and compiler-private snapshot shape. Even after std
analysis is removed, representative emission costs about 260–370 ms and
restoring the complete HIR/typing/binding object graph costs about 280 ms. The
snapshot nevertheless brings the new branch within the intended merge gate:
against the original V-448 baseline medians of 907.00 ms and 1,108.87 ms, the
fresh-process result is about 23.4% faster unoptimized and 2.9% faster in
release mode. A smaller public package-contract format and separately reusable
dependency codegen are the long-term path below this floor.
