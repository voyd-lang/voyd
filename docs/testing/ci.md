# Test And CI Modes

PR CI separates workloads so compile-heavy public tests do not serialize every
package unit behind one Turbo queue.

## Required Lanes

- `typecheck`: affected workspace typechecks through Turbo.
- `test`: affected package units, excluding the dedicated conformance and
  integration workspaces, with explicit package concurrency of three and one
  Vitest worker per package task.
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

Unit, conformance and integration jobs record the wall time of the complete
lane command, emit per-file Vitest JSON timing reports where applicable,
enforce the checked-in budgets in `scripts/testing/timing-budgets.json`, and
retain their summaries as 30-day CI artifacts. Measuring the full command keeps
Voyd-runner, grammar, and other non-Vitest package tasks inside the unit budget.
Initial budgets are intentionally generous enough to avoid runner noise;
tighten them from observed p95 data.
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

The first live hosted-runner integration baseline completed all 128 assertions
in about 201 seconds, with the slowest file at about 132 seconds. After the
public web package gained request streaming, SSE, and OpenAPI generation,
healthy runs completed in about 247 seconds with the expanded web fixture at
183-193 seconds. The budget is therefore 300 seconds for the lane and 210
seconds per file. This preserves the lane-wide regression guard while leaving
headroom for ordinary runner variance; tighten it after enough successful runs
exist to estimate p95 reliably.

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
