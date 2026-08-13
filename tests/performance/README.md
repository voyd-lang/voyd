# Performance tests

Performance tests and large regression workloads are opt-in. They do not run
as part of the default test suite.

## V-499 DTO and host-boundary gates

`npm run test:perf --workspace @voyd-lang/performance-tests` includes explicit
budgets for large arrays and byte buffers, nested records, variants, typed JSON
and MessagePack throughput, VX command batches, frequent event frames, and the
compiled artifact size. Each runtime budget also gates peak JavaScript heap
growth and WebAssembly linear-memory growth. The fixture deliberately compiles
without optimizer fusion so a mandatory intermediate tree cannot hide behind
optimization.
Set `VOYD_V499_PERF_GATE_MULTIPLIER` only when calibrating a materially slower
CI runner; the default multiplier is `1`.

## Intrinsic Array `for` benchmark

Measure intrinsic Array iteration against equivalent indexed-loop controls:

```sh
npm run bench:array-for -- \
  --label <label> \
  --compile-samples 5 \
  --runtime-samples 21 \
  --output /private/tmp/voyd-array-for.json
```

The light-body case makes iterator overhead visible. The render case traverses
view-model records and computes representative serialization work. Output is
JSON with raw and median compile/runtime samples, raw compiler phase/counter
summaries, peak RSS, checksums, Wasm/gzip sizes, and code-shape counts. Use
`--sdk-root /path/to/voyd-checkout` to compile the same fixture with another
installed checkout.

## General iterator `for` benchmark

Measure exact non-intrinsic user iterators against equivalent manual state
machines:

```sh
npm run bench:iterator-for -- \
  --label <label> \
  --compile-samples 7 \
  --runtime-samples 31 \
  --output /private/tmp/voyd-iterator-for.json
```

The focused case uses a light-body counter. The application-shaped case uses
a filtered, strided iterator with variable internal work and early returns.
Output includes raw compiler phase/counter and compile/runtime samples, peak
RSS, medians, checksums, Wasm/gzip size, and dispatch, allocation, Option, and
structural-access site counts. `--sdk-root` targets another installed compiler
checkout without changing the fixture.

## Mutable-result specialization benchmark

Measure mutable scalar-aggregate calls that both update request-local state and
return a value:

```sh
npm run bench:mutable-result -- \
  --label <label> \
  --compile-samples 7 \
  --runtime-samples 31 \
  --output /private/tmp/voyd-mutable-result.json
```

The fixture models the hot inner loop of a server-rendered response encoder. A
writer accumulates response bytes, emitted-node counts, escape events, and a
checksum while each helper returns the number of bytes it wrote. The benchmark
separately measures a caller that uses the result and one that discards it. A
manually expanded implementation provides a checksum-equivalence control.

Output is JSON with every raw compiler phase/counter and compile/runtime
sample, peak RSS, result checksums, Wasm/gzip sizes, and static call,
allocation, and structural-access site counts. To compare another compiler
checkout against the current fixture, add
`--sdk-root /path/to/voyd-checkout`. Run once with that flag and once without
it, then compare the reported medians, counters, and code-shape counts.

## Checked-access application benchmark

Run the complete checked-access benchmark suite from the repository root:

```sh
npm run bench:v439 -- --label <label> --samples 7 --runtime-samples 31
```

To measure only the representative server-rendered web-app request pipeline:

```sh
npm run bench:v439 -- \
  --label <label> \
  --samples 7 \
  --runtime-samples 31 \
  --scenario representative-web-app-request \
  --output /private/tmp/voyd-web-app-request.json
```

The web-app scenario runs 10,000 route, catalog/view-model, and response
serialization operations per sample. It reports the integrated handler plus
separate lookup and serialization stages. Each entrypoint uses a fresh warmed
host instance. Every counted setup, request-driver, array, and response-node
loop uses idiomatic range-based `for` syntax.

Compare another local compiler revision without copying the fixture by passing
the other checkout's repository root:

```sh
npm run bench:v439 -- \
  --label before \
  --samples 7 \
  --runtime-samples 31 \
  --scenario representative-web-app-request \
  --sdk-root /path/to/voyd-checkout
```

The JSON output includes all raw compiler phase/counter and compile/runtime
samples, peak RSS, medians, emitted Wasm and gzip sizes, artifact hashes,
whole-module and per-entrypoint instruction-site counts, host details, and
linear-memory growth. The committed V-439 results and methodology are in
`docs/notes/v439-checked-access-optimization-results.md`.

### V-500 Range and deferred-guard companions

The isolated Range workload measures a direct intrinsic Range loop and a
Range-derived `Array.at` checked-access loop in the same small fixture. It
retains separate runtime distributions and per-export WAT shapes, plus the
intrinsic-Range and Range/Array safe-scope disposition counters. The emitted
WAT signal is the absence of general `RangeIterator` machinery; the direct
counted-loop acceptance counter remains authoritative because Binaryen may
discard internal block labels:

```sh
npm run bench:v439 -- \
  --label <label> \
  --samples 7 \
  --runtime-samples 31 \
  --scenario isolated-range-optimizations \
  --output /private/tmp/v500-range-optimizations.json
```

The deferred-default companion workload forces an overlap guard to run after
an omitted default has been evaluated. Its report retains the nonzero deferred
guard and companion requested/created/compiled counters. Final WAT retains the
identity comparison and panic path; the focused compiler test owns the
pre-Binaryen companion-name assertion because Binaryen may inline the demanded
companion:

```sh
npm run bench:v439 -- \
  --label <label> \
  --samples 7 \
  --runtime-samples 31 \
  --scenario deferred-default-identity-guard \
  --output /private/tmp/v500-deferred-default-guard.json
```

### Idiomatic Vtrace renderer

Measure only the compute-bound path tracer with:

```sh
npm run bench:v439 -- \
  --label <label> \
  --samples 7 \
  --runtime-samples 31 \
  --scenario representative-vtrace
```

The fixture deliberately uses normal application source: mutable data is
modeled with `obj`, counted work uses range-based `for`, and the scene is
traversed with `for object in self.objects`. It avoids manual indexed-loop and
value-layout controls so the result includes the cost of Voyd's standard
abstractions. Use `--sdk-root` as shown above to compile this same source with a
different compiler checkout.

## Web OpenAPI package-scale compile

Run the dependency-heavy Web OpenAPI compile in a fresh Node process:

```sh
npm run bench:web-openapi
```

This command exercises the one-shot cache policy (`none`). It is the
cold-compilation baseline. Compare an incremental SDK by retaining one cache
for two compiles:

```sh
npm run bench:web-openapi -- --compiler-cache memory --compile-count 2
```

The benchmark targets
`packages/web/src/openapi/openapi_app.test.voyd` directly, so its workload does
not change when Web test files are added or shard ordering changes. Its JSON
output includes process wall time, compiler total time, all compiler phases and
counters, Node version, host details, exact child stdout/stderr, and the worker
process's operating-system `maxRSS`. Use `--output` to preserve the report
without shell redirection:

```sh
npm run bench:web-openapi -- \
  --output /private/tmp/voyd-web-openapi.json
```

For same-machine cold base/head evidence, use clean installed checkouts that
contain the same OpenAPI fixture. This runs one discarded warmup and seven
retained fresh-process compiles per checkout. Base/head execution order
alternates each sample round:

```sh
npm run bench:web-openapi -- \
  --repo base=/absolute/path/to/base-checkout \
  --repo head=/absolute/path/to/head-checkout \
  --compiler-cache none \
  --compile-count 1 \
  --warmups 1 \
  --samples 7 \
  --require-clean \
  --output /private/tmp/v500-web-openapi-base-head.json
```

The report records each checkout's revision and dirty state, fixture and source
input hashes, package-lock/manifests and installed dependency hashes, every raw
sample, distribution statistics, and same-machine median ratios. A checkout
that provides the V-500 compiler counter schema must publish every registered
counter, including zero values; the worker loads that schema from the checkout
being measured. Run `npm install` in each checkout: the controller rejects
workspace package links that resolve into a different checkout, because those
would silently compile with the wrong compiler or runtime source.

To collect a bounded Node CPU sampling profile at a 10 ms interval:

```sh
npm run bench:web-openapi -- --cpu-profile-dir /private/tmp/voyd-openapi-profile
```

Use `--timeout-ms <milliseconds>` to override the 15-minute child-process
timeout.
