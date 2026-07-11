# Former Smoke Suite Dispositions

This ledger records the file-level decision for every TypeScript test that was
under `apps/smoke` before the July 2026 migration. “Moved” means the behavior
and fixture remain intact in the named owner. “Extracted” means portable cases
were converted into manifest-driven conformance expectations. “Consolidated”
or “deleted” names the surviving canonical coverage.

| Former file                                | Disposition            | Current owner or replacement                                                        | Rationale                                                                                                                                            |
| ------------------------------------------ | ---------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `doc-generation.test.ts`                   | Moved                  | `tests/integration/src/doc-generation.test.ts`                                      | Public SDK plus documentation renderer boundary.                                                                                                     |
| `effect-buffer-size.test.ts`               | Moved                  | `tests/integration/src/effect-buffer-size.test.ts`                                  | SDK/default-host option plumbing.                                                                                                                    |
| `effects-e2e.test.ts`                      | Moved and consolidated | `tests/integration/src/effects-e2e.test.ts`                                         | Batched compile protects host continuation behavior; duplicate `EffectsInfo` helper assertions were removed in favor of SDK tests.                   |
| `effects-exports.test.ts`                  | Extracted              | `tests/conformance/cases/effects/effects-exports-*`                                 | Exported effect rows and `TY0016` are portable language contracts.                                                                                   |
| `html.test.ts`                             | Moved                  | `tests/integration/src/html.test.ts`                                                | MsgPack decoding through SDK and host is a composed boundary.                                                                                        |
| `local-rng-regression.test.ts`             | Deleted                | `packages/std/src/random.test.voyd`                                                 | Exact deterministic/range behavior already has a cheaper std-owned canonical suite.                                                                  |
| `node-modules-voyd-semver.test.ts`         | Moved                  | `tests/integration/src/node-modules-voyd-semver.test.ts`                            | Real installed-package resolution crosses SDK, filesystem and package boundaries.                                                                    |
| `open-callback-effect-rows.test.ts`        | Extracted              | `tests/conformance/cases/effects/open-callback-effect-rows.voyd`                    | Open effect-row behavior is compiler-independent.                                                                                                    |
| `optimization-differential.test.ts`        | Moved                  | `tests/integration/src/optimization-differential.test.ts`                           | Compares multiple public SDK optimization configurations and runtime traps.                                                                          |
| `optimized-wide-value-return.test.ts`      | Extracted              | `tests/conformance/cases/runtime/optimized-wide-value-return.voyd`                  | Observable optimized runtime behavior is portable.                                                                                                   |
| `prefix-minus.test.ts`                     | Extracted              | `tests/conformance/cases/runtime/prefix-minus.voyd`                                 | Operator semantics are portable.                                                                                                                     |
| `range-for.test.ts`                        | Extracted              | `tests/conformance/cases/runtime/range-for.voyd`                                    | Iteration and handled-effect results are portable.                                                                                                   |
| `range-generic-inference.test.ts`          | Extracted              | `tests/conformance/cases/typing/range-generic-inference.voyd`                       | Generic inference is a language contract.                                                                                                            |
| `runtime-trap-diagnostics.test.ts`         | Moved                  | `tests/integration/src/runtime-trap-diagnostics.test.ts`                            | Rich source metadata and scratch-buffer decoding are SDK/js-host contracts; normalized trap existence is also represented in conformance.            |
| `source-level-pkg.test.ts`                 | Extracted              | `tests/conformance/cases/modules/source-level-pkg`                                  | Source package exports and visibility diagnostics are portable.                                                                                      |
| `std-fs.test.ts`                           | Moved                  | `tests/integration/src/std-fs.test.ts`                                              | Exercises real Node filesystem adapters.                                                                                                             |
| `std-http.test.ts`                         | Moved                  | `tests/integration/src/std-http.test.ts`                                            | Exercises real Node HTTP client/server adapters.                                                                                                     |
| `std-input-output.test.ts`                 | Moved                  | `tests/integration/src/std-input-output.test.ts`                                    | Exercises std plus default input/output host adapters.                                                                                               |
| `std-math-constants.test.ts`               | Moved                  | `tests/integration/src/std-math-constants.test.ts`                                  | Retained as a narrow public std-import boundary; detailed math semantics remain std-owned.                                                           |
| `string-interpolation.test.ts`             | Extracted              | `tests/conformance/cases/syntax/string-interpolation.voyd`                          | Surface syntax and runtime string result are portable.                                                                                               |
| `string-slice-apis.test.ts`                | Moved                  | `tests/integration/src/string-slice-apis.test.ts`                                   | Proves public String/StringSlice overloads through the installed std boundary.                                                                       |
| `task-runtime.test.ts`                     | Moved                  | `tests/integration/src/task-runtime.test.ts`                                        | One expensive fixture protects many std/js-host scheduler boundaries.                                                                                |
| `trait-dispatch-labeled-container.test.ts` | Extracted              | `tests/conformance/cases/runtime/trait-dispatch-labeled-container.voyd`             | Trait dispatch and labeled arguments are portable.                                                                                                   |
| `value-types.test.ts`                      | Extracted              | `tests/conformance/cases/runtime/value-types.voyd`                                  | Batched observable value semantics are a primary rewrite contract.                                                                                   |
| `vtrace-compute-benchmark.test.ts`         | Moved out of default   | `tests/performance/src/vtrace-compute-benchmark.test.ts`                            | Benchmark and large deterministic workload are explicitly opt-in.                                                                                    |
| `vtrace-fast-regression.test.ts`           | Moved out of default   | `tests/performance/src/vtrace-fast-regression.test.ts`                              | Large external program is opt-in and now requires an explicit input path.                                                                            |
| `vx-dom.test.ts`                           | Moved                  | `tests/integration/src/vx-dom.test.ts`                                              | Compiler, SDK, std and DOM renderer composition.                                                                                                     |
| `wasm-validation.test.ts`                  | Moved, split deferred  | `tests/integration/src/wasm-validation.test.ts` plus `tests/conformance/cases/wasm` | Existing mixed suite remains for unique validation behavior; basic ABI is now portable and the remaining ownership split is recorded follow-up work. |
| `web-framework.test.ts`                    | Moved                  | `tests/integration/src/web-framework.test.ts`                                       | Public SDK plus `pkg::web` integration.                                                                                                              |

## Fixture-Only Decisions

| Former fixture                         | Disposition                           | Reason                                                          |
| -------------------------------------- | ------------------------------------- | --------------------------------------------------------------- |
| `optimization-tier1.voyd`              | Deleted                               | No test, script or documentation consumer.                      |
| `local-rng-regression.voyd`            | Deleted                               | Its only test was an exact std duplicate.                       |
| `scalar-aggregate-representative.voyd` | Moved to `tests/performance/fixtures` | Benchmark-only corpus.                                          |
| `vtrace-compute-benchmark.voyd`        | Moved to `tests/performance/fixtures` | Performance corpus, also consumed by the SDK cache stress test. |
| `animal.voyd`                          | Moved to `tests/integration/fixtures` | Required by the module-qualified return validation fixture.     |

## Cross-Layer Case Cleanup

- CLI e2e removed one compiler-owned companion-visibility case, one redundant
  nested compile subprocess, and the deep default `node_modules` matrix already
  owned by SDK/integration.
- SDK removed duplicate runtime-diagnostic defaults, an optimizer-semantic
  program owned by compiler/conformance, and a package+optimization composition
  already covered separately by SDK option tests and installed-package
  integration.
- Effects integration removed metadata helper cases canonically owned by SDK;
  runtime host-continuation cases remain.
