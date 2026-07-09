# Testing And CI Modes

This document explains which tests require source mode vs dist mode, and why the PR workflow is structured this way.

## CLI Runtime Selection (`scripts/voyd`)

`scripts/voyd` chooses the CLI runtime in this order:

1. `VOYD_USE_SRC=1` (or `VOYD_DEV=1`) forces source runtime.
2. Otherwise, `VOYD_USE_DIST=1` forces dist runtime and requires `apps/cli/dist/cli.js`.
3. Otherwise, runtime is auto-selected (`dist` when available, else `source`).

If both `VOYD_USE_DIST=1` and `VOYD_USE_SRC=1` are set, source mode wins and a warning is printed.

## What CI Validates

PR workflow (`.github/workflows/pr.yml`) runs complementary checks:

1. Main test sweep in source mode:
   - `VOYD_USE_SRC=1 npm run test:affected`
   - Fast path for broad correctness checks. Compiler codegen tests are split
     into their own sharded CI job because they dominate wall-clock time.
2. Compiler codegen in a separate sharded job (when compiler/runtime files change):
   - `npm run --workspace @voyd-lang/compiler test:codegen -- --shard=N/4`
   - Keeps the slowest compiler e2e-style tests off the main PR critical path.
3. Build-only validation for non-CLI artifacts (when relevant files change):
   - `npx turbo run build --affected --output-logs=errors-only`
   - Catches site/VSCode build regressions that package tests do not execute.
4. Dist-specific CLI e2e in a separate PR job (only on CLI/runtime-related changes):
   - Build targeted dist artifacts: `npx turbo run build --filter=@voyd-lang/cli...`
   - Run dist e2e: `VOYD_USE_DIST=1 VOYD_CLI_E2E_RUNTIME=dist npm run --workspace @voyd-lang/cli test:e2e`
   - Reported as its own status check (`cli-dist-e2e`) and runs in parallel
     with the main source-mode test sweep when the relevant files change.

This keeps most PRs fast while still protecting dist execution paths when they can be impacted.

## Regression Checklist

If you modify any of the following, ensure dist CLI e2e still runs:

- `apps/cli/**`
- `packages/compiler/**`
- `packages/lib/**`
- `packages/sdk/**`
- `packages/js-host/**`
- `packages/std/**`
- `scripts/voyd`

Recommended local commands before merging CLI/runtime changes:

- `VOYD_USE_SRC=1 npm run test:full`
- `npm run test:codegen`
- `npx turbo run build --filter=@voyd-lang/cli...`
- `VOYD_USE_DIST=1 VOYD_CLI_E2E_RUNTIME=dist npm run --workspace @voyd-lang/cli test:e2e`
