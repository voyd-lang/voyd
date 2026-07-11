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
  and retention rationale, enforced by `npm run test:audit`.

## Common Commands

```sh
npm test
npm run typecheck
npm run test:audit
npm run --workspace @voyd-lang/conformance-tests test
npm run --workspace @voyd-lang/integration-tests test
npm run test:perf
```

`npm test` remains the complete default local correctness sweep. Performance
tests are intentionally excluded unless invoked explicitly.
