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
