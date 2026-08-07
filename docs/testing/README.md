# Testing Guide

Read this guide before adding, moving or substantially expanding tests.

Voyd uses three primary correctness layers:

1. Co-located package tests for implementation details and package contracts.
2. `tests/conformance` for portable, externally observable language behavior.
3. `tests/integration` for behavior that composes multiple public packages or
   real host adapters.

Performance and large external regressions are opt-in under
`tests/performance`.

## Start Here

- [Ownership](ownership.md): choose the canonical layer.
- [Conformance](conformance.md): add portable language behavior.
- [Adding tests](adding-tests.md): control duplication and runtime cost.
- [CI](ci.md): understand required and opt-in lanes.
- [2026 audit](audit-2026-07.md): baseline, migration decisions and remaining
  cleanup opportunities.
- [Current test inventory](test-inventory.json): per-file owner, disposition
  and retention rationale, enforced by `npm run check:test-inventory`.

## The Default Contract

```sh
npm test
npm run check
```

Run both commands before handing off a code change.

`npm test` is the complete deterministic correctness suite. It includes:

- release and test-tooling tests;
- every workspace's default tests, including conformance and integration;
- the compiler codegen suite;
- CLI end-to-end tests against source; and
- CLI end-to-end tests against the current built distribution.

The local runner uses two resource-aware phases. Release/tooling tests run
alongside the workspace sweep; after both pass, codegen and the two CLI e2e
modes run concurrently. This keeps the compiler-heavy workspace sweep from
competing with three more compiler-heavy lanes. If `CI` is set, every lane runs
sequentially. PR CI does not invoke this root runner; it uses the
resource-limited, affected and sharded commands described in [CI](ci.md).

`npm run check` runs affected typechecks, affected lint tasks and the complete
test-inventory policy check. It does not execute tests.

Performance suites and benchmarks are intentionally outside both defaults.
They measure characteristics that can be slow or environment-sensitive rather
than deterministic correctness.

## Root Command Reference

### Developer commands

| Command | Purpose |
| --- | --- |
| `npm test` | Run every deterministic correctness lane, using Turbo's cache where applicable. |
| `npm run test:uncached` | Run the same suite while forcing every Turbo-backed test and build. Use this to reproduce a clean-machine run. |
| `npm run test:affected` | Run only affected workspaces' default `test` tasks. This fast iteration command omits compiler codegen and CLI source/dist e2e. |
| `npm run test:codegen` | Run the compiler codegen suite by itself. |
| `npm run test:tooling` | Run repository release-script and test-runner tooling tests by themselves. |
| `npm run test:perf` | Run the opt-in performance smoke suite. |
| `npm run check` | Run `typecheck`, `lint` and `check:test-inventory`. |
| `npm run typecheck` | Run affected workspace typechecks through Turbo. |
| `npm run lint` | Run affected workspace lint tasks through Turbo. |
| `npm run check:test-inventory` | Validate test ownership metadata and repository-wide test policy without executing tests. |
| `npm run update:test-inventory` | Add and remove inventory entries after test files change. New entries remain `needs-review` until a person records their contract and rationale. |

The test-inventory check walks every `.test`, `.spec` and `.test.voyd` file. It
rejects focused `.only` tests, missing or stale inventory entries, unreviewed
ownership decisions, invalid conformance IDs, missing conformance entries and
compiler-internal imports from portable conformance tests.

### CI implementation commands

These commands are wired into `.github/workflows/pr.yml`. Prefer the developer
commands above for ordinary local work.

| Command | Purpose |
| --- | --- |
| `test:unit:affected:ci` | Base affected package-unit command with conformance, integration and performance excluded. |
| `test:unit:core:affected:ci` | Unsharded core fallback excluding CLI, language server and web. |
| `test:unit:core:shard:1:ci` | First duration-balanced core shard: compiler, std and SDK assignments. |
| `test:unit:core:shard:2:ci` | Second duration-balanced core shard and remaining package units. |
| `test:unit:web:ci` | Combined web-package compile/test lane. |
| `test:unit:tooling:affected:ci` | Affected CLI and language-server unit lane with hosted-runner concurrency limits. |
| `test:web-compile-gate` | Cold whole-web compile memory/time gate for optimizer-sensitive changes. |

## Package-Specific Commands

`npm run --workspace <workspace> test` runs that workspace's canonical default
tests. The following variants exist because they protect a distinct boundary
or provide a useful debugging mode:

| Workspace command | Purpose |
| --- | --- |
| `@voyd-lang/compiler test:codegen` | Compiler codegen tests, kept separate from compiler unit tests for cost and sharding. |
| `@voyd-lang/cli test:e2e` | Full CLI end-to-end behavior. `VOYD_CLI_E2E_RUNTIME=dist` selects the built distribution. |
| `@voyd-lang/cli test:dist-smoke` | Small built-CLI signal used in CI when upstream runtime code changes without direct CLI changes. |
| `@voyd-lang/web test:isolated` | Low-memory/debugging fallback that runs eight sequential compile partitions. |
| `@voyd-lang/web test:sharded -- --partition-index=N --partition-count=M` | Run one explicit web-test partition. |
| `@voyd-lang/conformance-tests test:shard -- --shard=N/M` | Run one single-worker conformance shard. |
| `@voyd-lang/performance-tests test:perf` | Direct form of the opt-in performance smoke suite. |
| `test:w` in compiler, SDK or language server | Run that package's Vitest suite in watch mode. |
