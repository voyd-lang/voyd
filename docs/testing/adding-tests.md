# Adding Tests

Before adding a test, answer:

1. Which contract does it protect?
2. Which layer is the canonical owner?
3. Does equivalent coverage already exist?
4. Would another compiler need to pass it unchanged?
5. What is the cheapest layer that catches the regression?
6. Can it reuse an existing compiled fixture?
7. Did it fail before the implementation or fix?
8. What runtime did it add?

## Cost Guidance

- Prefer focused units for algorithms and internal invariants.
- Compile one subsystem fixture and expose several clearly named entrypoints
  when compiler/std setup dominates runtime.
- Do not combine unrelated behavior merely to save one compilation.
- Keep CLI subprocess coverage to CLI-owned behavior.
- Keep SDK compile/run signals representative; language matrices belong in
  conformance.
- Put benchmarks, large sweeps and external programs in `tests/performance`.
- Record before/after timing when adding a compile-heavy file or materially
  expanding an integration fixture.
- Do not raise a lane timing budget merely to land a test. First consolidate
  setup or move non-required work to the performance lane; explain any budget
  change with measured p95 evidence.

## Regression Evidence

New regression tests should fail on the buggy implementation. When reproducing
the failure directly is impractical, explain why and identify the pre-existing
test boundary that would have missed it.

After adding or removing a test file, run `npm run test:audit:update`, then edit
the new `needs-review` entry in `docs/testing/test-inventory.json` to record the
contract-based disposition and rationale. The update command preserves prior
decisions; it never infers that a test is correctly placed from its directory.

Run `npm run test:audit` before submitting. It rejects unreviewed inventory
entries, focused `.only` tests, obsolete `apps/smoke` placement and
compiler-internal imports from the conformance suite.
