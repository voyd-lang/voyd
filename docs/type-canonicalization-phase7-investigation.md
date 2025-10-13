# Type Canonicalization Phase 7 – Investigation

## Summary
- Re-running the wasm regression still traps with `RuntimeError: illegal cast`, and four of the `map-recursive-union` e2e guards fail because duplicate Optional constructors survive Binaryen lowering.
- Phase 7’s goal (“reattach orphaned Optional instances and make Binaryen reuse the canonical heap ids”) is not met. After canonicalization there are still multiple `Some#…` objects for the same specialization, and they are **not** re-registered under the canonical parent.
- These orphaned Optionals leak into codegen, yielding 46 `struct.new $Some#…` calls (expected 1) and non-idempotent function name sets, so we continue chasing the same runtime failure.

## Test Status
- `npx vitest run src/__tests__/run-wasm-regression.e2e.test.ts` → fails with `RuntimeError: illegal cast`.
- `npx vitest run` → `map-recursive-union.e2e.test.ts` reports four regressions (duplicate optional constructors/functions and wasm nondeterminism).
- All other suites currently pass, so the fallout is concentrated around the canonicalization watchdogs.

## Optional Constructor Audit
- Running `npx tsx scripts/inspect-optional-constructors.ts` against the current `processSemantics` output shows:
  - **15** `Some#…` instances remain in the canonical AST (up from the expected 1–2).
  - **10** of those are attached to `Some#144032.genericInstances`, but **5 are orphaned** (not present in the parent list after dedupe).
  - Wasm text contains **46** `struct.new $Some#…` and **66** `struct.new $None#…` invocations; we expect a single constructor call for each.
- Re-running `canonicalizeResolvedTypes` in isolation confirms the orphans persist even after five iterations; the pass never reattaches them.

## Evidence of Orphaned RecType Optionals
- Script snapshot (see `npx tsx` snippet below) reports five orphan `Some` objects, including the one specialised for `RecType`:

  ```ts
  const { some, parentByInstance } = collectOptionalConstructors(canonicalRoot);
  const orphans = [...some].filter((obj) => {
    const parent = parentByInstance.get(obj);
    if (!parent) return false;
    return !(parent.genericInstances ?? []).includes(obj);
  });
  ```

  Output:

  ```
  Orphan Some instances: 5
    Some#144032#11 parent=Some#144032 arg=RecType#143181
    Some#144032#7  parent=Some#144032 arg=CombinedTypeUnion#201691
    Some#144032#10 parent=Some#144032 arg=102640#146526#0
    Some#144032#8  parent=Some#144032 arg=99472#146241#1
    Some#144032#9  parent=Some#144032 arg=Array#147631#5
  ```

- `Some#144032#11` is the canonical RecType optional we expect to keep; `Some#144032#6` is the competing clone. Because callers/match arms still point at the orphaned id, Binaryen emits distinct heap types and the run-time `ref.cast` fails.

## Where the Pass Falls Short
- `attachInstanceToParent` attempts to merge instances back into the canonical parent (`src/semantics/types/canonicalize-resolved-types.ts:225`). However, we only invoke it when the current `ObjectType` already appears in `genericInstances` or when we encounter it inside specific union flows. Once we set `instance.genericInstances = []` during dedupe (`src/semantics/types/canonicalize-resolved-types.ts:199-218`), the orphan is never re-queued, so the parent list stays stale.
- Phase 7’s plan (“reattach the orphaned ids after caches are cleared; fall back to the canonical instance whenever Binaryen lowering requests the orphaned ids”) is partially implemented—the caches are cleared, but the reattachment never succeeds, so Binaryen still sees multiple heap ids and emits extra constructors.
- Because the canonical parent no longer enumerates these clones, any later pass that relies on `Some#144032.genericInstances` (including Binaryen lowering) silently misses them, leading to nondeterministic wasm output and the observed regression tests.

## Impact on Codegen
- `npx tsx scripts/inspect-optional-constructors.ts` confirms 46 `struct.new $Some#…` occurrences; the e2e asserts expect 1. The extra instantiations correspond to the orphaned ids listed above.
- `map-recursive-union.e2e.test.ts` therefore fails its “single Optional constructor” guard, the “no duplicate helper names” guard, and the “idempotent wasm function set” guard.
- Recompiling the same canonical AST twice still produces differing function name sets, which is why the deterministic compilation test fails: the orphaned clones are re-materialised with fresh `#` suffixes on every run.

## Next Steps
1. Ensure `attachInstanceToParent` (or a new post-pass) re-inserts every orphaned instance into the parent’s `genericInstances` list—even after we clear caches or strip duplicates—so lookups during codegen never see the stale ids.
2. When Binaryen lowering encounters an orphan id, explicitly swap it for the canonical parent entry rather than letting Binaryen allocate a fresh struct.
3. Add targeted coverage that asserts `parent.genericInstances` contains every optional clone seen by the AST walker; this will prevent the orphan scenario from silently returning.
4. Once orphans are eliminated, re-run `npx vitest run` and verify the wasm guards (constructor counts, helper name sets, and deterministic compilation) pass before moving on to subsequent phases.

## Phase 1 Snapshot (Plan 4)

### Test Failures
- `npx vitest run src/__tests__/run-wasm-regression.e2e.test.ts` still fails: the regression harness looks for `test.voyd`, but the file is missing so the run aborts before wasm execution (`ENOENT` from `stat('/workspace/voyd/test.voyd')`).
- `npx vitest run src/__tests__/map-recursive-union.e2e.test.ts` continues to report four failing guards:
  - Runtime trap persists (`RuntimeError: illegal cast`).
  - Optional constructor guard sees four `Some` instantiations instead of one.
  - Optional helper dedupe guard finds 14 duplicate helper exports (all `iterate#…` variants).
  - Determinism guard still diffs 715 vs. 270 wasm functions between two compiles of the same program.

### Optional Constructor Audit
- `npx tsx scripts/inspect-optional-constructors.ts` enumerates **15** `Some#144032#…` constructors and **1** `None#144037`, matching the previously observed inflation.
- Only 10 of the `Some` variants remain attached to `Some#144032.genericInstances`, leaving **5** orphans reachable only by direct references.
- Union nodes referencing Optionals still materialize 15 edges, so Binaryen keeps allocating fresh heap types for the orphans.

### Instrumentation
- Added a `CANON_DEBUG` flag to `canonicalize-resolved-types.ts`. When enabled, the pass now logs any `ObjectType` whose canonical parent omits it from `genericInstances` or whose `genericParent` pointer drifts away from the canonical parent.
- `debugCheckParentRegistration` fires during instance attachment, and an additional check inside `canonicalTypeRef` warns whenever a canonical lookup observes a missing parent/child registration. The default behavior remains unchanged when `CANON_DEBUG` is unset, so existing tests still fail in the same manner.

### Handoff Notes
- Optional constructor counts: 15 `Some`, 1 `None`; 5 `Some` instances remain orphaned from the parent list.
- Duplicate Optional helpers: 14 extra `iterate#…` exports; wasm function sets still diverge (715 vs. 270 functions).
- Instrumentation available: set `CANON_DEBUG=1` to surface missing parent/child registrations during canonicalization.
