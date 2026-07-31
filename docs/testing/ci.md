# Test And CI Modes

PR CI separates workloads so compile-heavy public tests do not serialize every
package unit behind one Turbo queue.

## Required Lanes

- `typecheck`: affected workspace typechecks through Turbo.
- `test`: affected core package units, excluding the dedicated conformance,
  integration and developer-tooling workspaces, with explicit package
  concurrency of three and one Vitest worker per package task.
- `tooling-unit`: affected CLI and language-server package units, with the two
  package tasks running concurrently and one Vitest worker per task.
- `conformance`: the portable language corpus when compiler/runtime inputs can
  affect it.
- `integration`: cross-package public behavior when an upstream package can
  affect it.
- `compiler-codegen`: four Vitest shards for compiler codegen.
- `cli-dist-e2e`: the full distributed CLI suite for direct CLI changes; a
  small startup/compile/run/test smoke for upstream runtime changes.
- `optimizer-scorecard`: conditional optimizer regression comparison.

Superseded PR runs are cancelled. Turbo caches are restored only in jobs that
actually execute Turbo tasks; direct Vitest jobs do not restore an ineffective
Turbo cache.

Core-unit, tooling-unit, conformance and integration jobs record the wall time
of the complete lane command, emit per-file Vitest JSON timing reports where
applicable, enforce the checked-in budgets in
`scripts/testing/timing-budgets.json`, and retain their summaries as 30-day CI
artifacts. Measuring the full command keeps Voyd-runner, grammar, and other
non-Vitest package tasks inside the unit budget. Initial budgets are
intentionally generous enough to avoid runner noise; tighten them from observed
p95 data.
Dedicated conformance and integration jobs each use two Vitest workers, so the
unit lane's three-package concurrency cannot multiply into unbounded nested
worker pools.

The shared Vitest configuration defaults to one worker when `CI` is set and
uses Vitest's unrestricted worker default otherwise. `VITEST_MAX_WORKERS`
overrides both behaviors. This keeps hosted runners bounded without forcing
developer machines to run compiler tests serially.

`npm run test:full` also runs its independent compiler-codegen and CLI e2e
tail phases concurrently after the main workspace sweep completes.

The first broad upstream unit runs after the lane split varied from about 224
to 342 seconds on hosted runners. The slowest unchanged file varied from about
119 to 147 seconds, and the file exceeding the limit changed between attempts
even though every test passed. The initial unit guardrail is therefore 420
seconds for the lane and 180 seconds per file. This retains regression
detection without making ordinary hosted-runner variance a required-check
failure; tighten it once retained artifacts provide a credible p95 baseline.
The CLI and language-server packages have their own unit shard because their
compile-heavy files can dominate broad upstream runs. The split stays at
package boundaries so Turbo's affected selection remains authoritative and new
test files cannot silently fall out of CI.

### V-448 tooling transition

V-448's call-scoped memory and mutation analysis increased the cost of source
compilations used by two developer-tooling test files. On PR #752, hosted CI
measured `apps/cli/src/__tests__/bootstrap.test.ts` at 208,119 ms and
`packages/language-server/src/__tests__/project.test.ts` at 190,624 ms. Both
exceeded the general 180,000 ms per-file budget while the tooling lane stayed
within its 420,000 ms wall-time budget.

The transition allowance preserves the lane-wide budget and every test:

- `bootstrap.test.ts`: 240,000 ms
- `project.test.ts`: 240,000 ms
- every other unit test file: 180,000 ms

These are exact-path overrides, not basename-wide or lane-wide increases. They
include roughly the same runner-noise headroom as the original unit budget.

V-462, **Build package-scale incremental compilation after V-448**, must define
the reusable package semantic interfaces that make these independent analyses
cheaper. V-467, **Persist package and callable caches across processes**, must
then remove repeated package and callable work from fresh tooling processes.
After those land, V-468, **Rebaseline compiler performance and restore strict
CI gates**, must use at least ten successful hosted tooling timing artifacts,
set caps from observed p95 plus 20% runner headroom, delete these exact-path
exceptions when that value is at or below the general 180,000 ms limit, and
restore strict permanent budgets. Keep the 420,000 ms lane guard unchanged
throughout so aggregate regressions remain visible.

### V-448 SDK transition

The SDK's end-to-end web helper test performs a first compile of the full web
package before checking readiness, requests, and shutdown. On PR #752, hosted
CI completed that test in 260,705 ms after its 120,000 ms Vitest timeout had
already fired. The complete `sdk-node.test.ts` file took 349,978 ms, and the
affected core-unit command took 523,746 ms. An isolated local run completed the
same test and all shutdown assertions in 59,750 ms, confirming slow compilation
rather than a server or cancellation hang.

The temporary allowances preserve the test and the ordinary unit defaults:

- only `closes a long-running web app entry through the SDK helper` has a
  330,000 ms test timeout;
- only `packages/sdk/src/__tests__/sdk-node.test.ts` has a 420,000 ms file
  budget;
- only the exact `npm run test:unit:core:affected:ci` command has a 630,000 ms
  wall budget;
- every other unit test file retains the 180,000 ms budget, and every other
  unit command—including the tooling shard—retains the 420,000 ms wall budget.

V-462 and V-467 must make package semantics and callable caches reusable across
the SDK's fresh web-package compilation. After they land, V-468 must collect at
least ten successful hosted core-unit timing artifacts, set temporary bounds
from observed p95 plus 20% runner headroom, remove the exact file and command
overrides when they fit under the ordinary limits, and restore the test's
120,000 ms timeout. Assertions and test files must not be skipped to meet a
timing budget.

The first live hosted-runner integration baseline completed all 128 assertions
in about 201 seconds, with the slowest file at about 132 seconds. After the
public web package gained request streaming, SSE, and OpenAPI generation,
healthy runs completed in about 247 seconds with the expanded web fixture at
183-193 seconds. Follow-up runner variance brought the pre-V-448 budget to 375
seconds for the lane, 210 seconds per file, and a 270-second VX file override.
This preserved the lane-wide regression guard while leaving headroom for
ordinary runner variance.

### V-448 integration transition

V-448 also increased the semantic-analysis cost of the integration suite's two
web-package compilations. On PR #752, hosted CI measured
`vx-dom.test.ts` at 345,303 ms; its initial web-package compile reached the
180,000 ms test timeout after 191,849 ms. The shared web-framework fixture hit
the same 180,000 ms hook timeout. The retained timing artifact records a
396,968 ms failed lane wall time. On the same revision, isolated local runs
completed `web-framework.test.ts` in 95,660 ms and `vx-dom.test.ts` in 102,770
ms, confirming slow completion rather than a hang.

The VX tests now share one SDK instance so their distinct entry compilations
reuse the package dependency snapshot. A local validation of the complete stack
passed all 33 affected assertions in 84,550 ms. The first hosted rerun with
that reuse passed all 141 assertions:
`vx-dom.test.ts` completed in 280,143 ms and `web-framework.test.ts` completed
in 91,818 ms. Its 427,481 ms lane wall time exceeded the pre-V-448 375,000 ms
cap even though both file caps passed.

A subsequent hosted run after bounded borrow-summary inference passed all 141
assertions in 312,358 ms. `vx-dom.test.ts` completed in 208,424 ms and
`web-framework.test.ts` in 73,857 ms. A later hosted run (30600608976) again
passed all 16 files and 141 assertions, but its 394,740 ms lane wall exceeded
the restored 375,000 ms cap. In that run, `vx-dom.test.ts` took 256,162 ms,
`wasm-validation.test.ts` took 106,437 ms, and `web-framework.test.ts` took
91,427 ms. This is healthy hosted-runner variance across several compile-heavy
files, not a failed assertion or an individual-file overrun.

The temporary hosted-runner allowances preserve every assertion:

- the two initial web-package compile test/hook timeouts are 240,000 ms;
- the exact paths `tests/integration/src/vx-dom.test.ts` and
  `tests/integration/src/web-framework.test.ts` each have a 330,000 ms file
  budget;
- every other integration file retains the 210,000 ms budget;
- only the integration lane wall budget increases from 375,000 ms to 420,000
  ms, leaving 25,260 ms of headroom over the latest healthy run.

V-462 and V-467 must make package semantics and callable caches reusable across
these compilations and fresh processes. After they land, V-468 must collect at
least ten successful hosted integration timing artifacts and set budgets from
p95 plus 20% runner headroom. It must remove this 420,000 ms transition
allowance by restoring the 375,000 ms lane cap when that measured bound fits,
or tighten below 375,000 ms if the data supports it. V-468 must also remove the
two file overrides when they fit under the general limit and restore the
180,000 ms compile timeout when that value exceeds the measured bound.
Assertions and test files must not be skipped to meet a timing budget.

## Runtime Selection

`scripts/voyd` selects the CLI runtime in this order:

1. `VOYD_USE_SRC=1` or `VOYD_DEV=1` forces source mode.
2. `VOYD_USE_DIST=1` forces the built CLI.
3. Otherwise it uses dist when present and source when absent.

The ordinary PR suites use source mode. The CLI distribution job builds and
tests dist explicitly.

## Tradeoffs

Separate jobs use more parallel runner minutes and repeat dependency
installation, but recent installs take seconds while the former serialized
test step took seven to eight minutes. The split optimizes feedback latency
without moving full correctness coverage to a nightly-only lane.

Codegen keeps path-based Vitest sharding for now. Duration-aware sharding needs
a checked-in timing map and reproducible sequencer; hard-coded file lists would
quickly become stale.
