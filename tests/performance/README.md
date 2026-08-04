# Performance tests

Performance tests and large regression workloads are opt-in. They do not run
as part of the default test suite.

## Web OpenAPI package-scale compile

Run the dependency-heavy Web OpenAPI compile in a fresh Node process:

```sh
npm run bench:web-openapi
```

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
