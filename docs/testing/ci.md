# Test And CI Modes

PR CI separates compile-heavy workloads so one package cannot serialize the
complete correctness suite behind a single Turbo queue.

## Required lanes

- `typecheck`: affected workspace typechecks through Turbo.
- `test`: two duration-balanced shards for affected core package units,
  excluding conformance, integration, web-package, performance, and
  developer-tooling workspaces. Compiler files are balanced from measured
  timings, and standard-library test modules are divided between both jobs.
  The SDK's base group and measured lighter std partitions run in the first
  shard. Its external-adapter groups, the measured heavier std partitions, and
  the remaining package units run in the second shard beside the non-CLI
  artifact build and typing gate.
- `web-unit`: affected Voyd web-package tests in one combined compile.
- `tooling-unit`: affected CLI and language-server units, with the two package
  tasks concurrent and one Vitest worker per task.
- `conformance`: portable language behavior when compiler/runtime inputs can
  affect it.
- `integration`: cross-package public behavior when an upstream package can
  affect it.
- `compiler-codegen`: two duration-balanced Vitest shards for compiler codegen.
- `cli-dist-e2e`: full distributed CLI coverage for direct CLI changes and a
  smaller dist smoke for upstream runtime changes.
- `optimizer-scorecard`: two scenario-balanced optimizer regression shards.
  When the whole-web memory gate also runs, it is paired with the lighter
  scenario set.

Superseded PR runs are cancelled. Turbo caches are restored only for jobs that
actually execute Turbo tasks; direct Vitest or Voyd test jobs do not restore an
ineffective Turbo cache.

`npm run test:full` runs its independent compiler-codegen and CLI e2e tail
phases concurrently after the main workspace sweep.

## Timing and resource budgets

Core-unit, web-unit, tooling-unit, conformance, and integration jobs measure
the complete lane command. Vitest lanes also emit per-file timing reports. The
jobs enforce `scripts/testing/timing-budgets.json` and retain summaries for 30
days. Measuring the full command keeps Voyd-runner, grammar, and other
non-Vitest work inside the lane budget.

Compiler unit and codegen shards discover the complete suite before assigning
files. Measured slow files carry explicit weights; new files receive a stable
default weight and are still assigned automatically. The standard-library
runner expands the two logical jobs into four sequential `voyd test --shard
N/4` compile partitions. It pairs the even partitions with the SDK base group
and runs the disproportionately expensive odd partitions beside the SDK's two
external-adapter groups. The second shard also owns the conditional build and
typing gates. Every SDK group and discovered std module is assigned exactly
once. This avoids silently dropping new tests while keeping compile-heavy work
active in both jobs.

The unsharded SDK command runs its base group alongside the sequential pair of
external-adapter groups on local machines. CI and explicit SDK shards remain
sequential so hosted runners retain predictable CPU and memory use.

The shared Vitest configuration defaults to one worker in CI and uses Vitest's
unrestricted default locally. `VITEST_MAX_WORKERS` overrides both behaviors.
Conformance and integration explicitly use two workers.

The general unit guardrails are:

- lane wall time: 420,000 ms;
- file time: 180,000 ms.

The CLI and language-server packages have a dedicated tooling lane because
their compile-heavy files can dominate a broad upstream run. The split stays at
package boundaries so Turbo's affected selection remains authoritative.

## V-448 temporary limits

V-448 added borrow analysis and versioned callable summaries. Fresh compiles
analyze the standard library from source; repeated compiles through one SDK can
reuse unchanged dependency semantics in process. The measurements and
hosted-run history are recorded in [Memory and mutation safety
performance](./memory-and-mutation-safety-performance.md).

The limits below are narrowly scoped and retain all assertions. They describe
the current CI contract; cleanup and remeasurement are tracked exclusively by
[V-468](https://linear.app/voyd-lang/issue/V-468). Package-scale performance
work is tracked under [V-462](https://linear.app/voyd-lang/issue/V-462).

### Tooling

- `apps/cli/src/__tests__/bootstrap.test.ts`: 240,000 ms;
- `packages/language-server/src/__tests__/project.test.ts`: 240,000 ms;
- every other tooling file: 180,000 ms;
- tooling lane wall time: 420,000 ms.

These are exact-path overrides, not basename-wide or lane-wide increases.

### SDK and core units

- only `closes a long-running web app entry through the SDK helper` has a
  330,000 ms test timeout;
- only `packages/sdk/src/__tests__/sdk-node.test.ts` has a 420,000 ms file
  budget;
- the unsharded `npm run test:unit:core:affected:ci` fallback retains its
  630,000 ms command budget;
- each CI core shard and every other unit command retain the 420,000 ms wall
  budget;
- each outer `test` shard has a 25-minute orchestration ceiling so setup,
  post-command checks, conditional builds, and benchmarks can follow a healthy
  bounded core command.

### Conformance

- `tests/conformance/src/runtime.test.ts`: 80,000 ms;
- every other conformance file: 60,000 ms;
- conformance lane wall time: 120,000 ms.

The runtime override is based on five recent Node 24 hosted-run measurements
from 54,505 ms to 74,432 ms. It keeps the general conformance limit unchanged
while giving the compile-heavy runtime corpus measured runner headroom.

### Web package

The web package is excluded from the core Turbo queue and runs through a direct,
non-cached matrix. Its path filter includes the web package and every source
compiler, runtime, standard-library, SDK, CLI, and test-runner input that can
change its result.

`voyd test --shard N/M` discovers and sorts test modules before compilation,
selects modules by deterministic round-robin index, and compiles each selected
set together once. CI and the default local suite compile all 24 files together
to avoid paying compiler startup and standard-library analysis costs once per
partition. `npm run --workspace @voyd-lang/web test:isolated` retains eight
sequential partitions as a low-memory and debugging fallback. The generic
shard runner still supports explicit partition selection for CI diagnostics.

- exact command `npm run test:unit:web:ci`: 600,000 ms;
- compiler-process hard timeout: 600,000 ms;
- job orchestration ceiling: 15 minutes;
- timing artifact: `web-unit-test-timings`, retained for 30 days.

The string-overload freshness check runs before the combined command.

The optimizer scorecard path filter includes `packages/compiler/src/semantics`
and `packages/compiler/src/modules`. Those changes also run
`npm run test:web-compile-gate`, which compiles the web integration fixture in
one fresh process with `compilerCache: "none"` under a 3.5 GiB V8 heap and
enforces 240 seconds / 4.25 GiB peak RSS. The gate therefore measures a true
one-shot cold build: it imports no artifact, captures no in-process dependency
snapshot, and performs no artifact serialization. Shards cannot mask an
aggregate package OOM.

### Integration

- initial web-package compile test/hook timeouts: 240,000 ms;
- integration command wall time: 600,000 ms;
- `tests/integration/src/vx-dom.test.ts`: 390,000 ms;
- `tests/integration/src/web-framework.test.ts`: 330,000 ms;
- every other integration file: 210,000 ms;

The VX integration tests share one SDK instance so distinct entry compilations
can reuse the in-process package dependency snapshot.

## Runtime selection

`scripts/voyd` selects the CLI runtime in this order:

1. `VOYD_USE_SRC=1` or `VOYD_DEV=1` forces source mode.
2. `VOYD_USE_DIST=1` forces the built CLI.
3. Otherwise it uses dist when present and source when absent.

Ordinary PR suites use source mode. The CLI distribution job builds and tests
dist explicitly.

## Tradeoffs

Separate jobs use more parallel runner minutes and repeat dependency
installation. The lane split favors bounded memory and fast reviewer feedback
while preserving full required coverage on every relevant PR.
