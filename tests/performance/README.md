# Performance tests

Performance tests and large regression workloads are opt-in. They do not run
as part of the default test suite.

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
  --scenario representative-web-app-request
```

The web-app scenario runs 10,000 route, catalog/view-model, and response
serialization operations per sample. It reports the integrated handler plus
separate lookup and serialization stages. Each entrypoint uses a fresh warmed
host instance.

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

The JSON output includes all raw samples, medians, emitted Wasm and gzip sizes,
artifact hashes, static instruction-site counts, host details, and memory
growth. The committed V-439 results and methodology are in
`docs/notes/v439-checked-access-optimization-results.md`.

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

Artifact generation is a distinct, opt-in workload:

```sh
npm run bench:web-openapi -- --compiler-cache artifact
```

Artifact mode intentionally retains and fingerprints additional borrowing
state. Compare it to the cold path only when evaluating artifact production,
not normal compilation latency.

The benchmark targets
`packages/web/src/openapi/openapi_app.test.voyd` directly, so its workload does
not change when Web test files are added or shard ordering changes. Its JSON
output includes process wall time, compiler total time, all compiler phases and
counters, Node version, and host details.

To collect a bounded Node CPU sampling profile at a 10 ms interval:

```sh
npm run bench:web-openapi -- --cpu-profile-dir /private/tmp/voyd-openapi-profile
```

Use `--timeout-ms <milliseconds>` to override the 15-minute child-process
timeout.
