# Type Canonicalization Hardening – Plan 4

## North Star
- `npx vitest run src/__tests__/run-wasm-regression.e2e.test.ts` must pass (no `RuntimeError: illegal cast`).
- `npx vitest run src/__tests__/map-recursive-union.e2e.test.ts` must pass with all guards enabled (single Optional constructor, no duplicate helpers, deterministic wasm output).
- All existing unit and e2e suites (`npx vitest run`) should remain green.

## Operating Model
- Each phase is self-contained so an LLM can execute it with a fresh context snapshot. Phases **must** be executed in order; state produced in one phase is persisted in the repo for the next.
- During a phase, the agent should prefer making only the modifications enumerated in that phase. If, while executing a phase, the agent discovers additional changes are absolutely required to reach the North Star, it should:
  1. Document the discovery in the phase report (see “Expected artifacts” below).
  2. Implement the minimal fix needed, keeping changes scoped and testable.
  3. Note any remaining follow-up in the next phase’s “open questions” section.
- Every phase ends with a validation step and a hand-off artifact so the next agent has concrete breadcrumbs (even if the CLI context resets).

## Phase Structure
For consistency, each phase below follows this layout:
- **Goal**: crisp statement of what success looks like.
- **Prep**: commands or notes the agent should run before coding.
- **Execution**: concrete tasks to perform; follow in order unless a dependency blocks progress.
- **Validation**: checks/tests required before closing the phase.
- **Artifacts**: files or notes to persist (update an existing doc or add a new one as instructed).
- **Handoff**: bullet list of what the next phase should be aware of (fill in once work is complete).

---

## Phase 1 – Baseline Snapshot & Instrumentation
- **Goal**: Capture the current failure mode in code and documentation so later phases can compare progress.
- **Prep**
  - Run `npx vitest run src/__tests__/run-wasm-regression.e2e.test.ts`.
  - Run `npx vitest run src/__tests__/map-recursive-union.e2e.test.ts`.
  - Run `npx tsx scripts/inspect-optional-constructors.ts`.
- **Execution**
  1. Record the key findings (illegal cast stack trace, failing assertions, optional constructor counts) in `docs/type-canonicalization-phase7-investigation.md` (append a “Phase 1 Snapshot” section).
  2. Add targeted logging or assertions if needed to expose orphaned generics—for example, instrument `canonicalize-resolved-types.ts` to assert when an `ObjectType`’s `genericParent` differs from the canonical parent’s registered child. Keep guards behind an environment flag (`process.env.CANON_DEBUG`) so tests remain deterministic.
  3. If any instrumentation reveals new facts, update the snapshot notes accordingly.
- **Validation**
  - Ensure the newly added instrumentation does not change current test outcomes (the two failing suites should still fail in the same way).
- **Artifacts**
  - Updated `docs/type-canonicalization-phase7-investigation.md` with Phase 1 results.
  - Optional: new environment flag or helper functions checked into source.
- **Handoff**
  - Summarize the orphan counts and constructor duplication numbers.
  - List any new assertions/flags introduced.

## Phase 2 – Canonical Reference Coverage Audit
- **Goal**: Guarantee every `Type` reference in the AST/metadata is eligible for canonical rewriting.
- **Prep**
  - Identify structures that still hold stale references (functions, trait implementations, cached call types); use the instrumentation from Phase 1.
- **Execution**
  1. Extend `canonicalize-resolved-types.ts` traversal to cover any missing surfaces (e.g., `Fn.genericInstances`, `Implementation.methods`, trait method tables, cached `call.fn` handles).
  2. Add a utility `assertCanonicalTypeRef(type)` (in `src/semantics/types/debug/`), which verifies that `canonicalTypeRef` returns the canonical object for the provided instance. Use it in strategic spots during the pass when `CANON_DEBUG` is enabled.
  3. Update or add unit tests under `src/semantics/types/__tests__/canonicalize-resolved-types.test.ts` that construct representative AST fragments and assert identity convergence after canonicalization.
- **Validation**
  - `npx vitest run src/semantics/types/__tests__/canonicalize-resolved-types.test.ts`
  - `npx vitest run src/__tests__/map-recursive-union.e2e.test.ts` (expected to still fail, but make sure no new regressions appear).
- **Artifacts**
  - Code changes in `canonicalize-resolved-types.ts` plus any new helpers/tests.
  - Update `docs/type-canonicalization-plan-3.md` (or add an appendix) noting coverage gaps addressed.
- **Handoff**
  - Enumerate any remaining reference surfaces still uncertain.
  - Provide a quick table mapping AST fields to the function that now canonicalizes them.

## Phase 3 – Generic Instance Reconciliation
- **Goal**: Rebuild `genericInstances` relationships generically (not Optional-specific) so canonical parents enumerate every surviving instance.
- **Prep**
  - Review `CanonicalTypeTable.#copyMetadata` and `dedupeCanonicalInstances` to understand current mutation points.
- **Execution**
  1. Introduce a reconciliation helper (e.g., `reconcileGenericInstances(parent: ObjectType, instances: ObjectType[])`) that:
     - Merges all clones targeting the same `appliedTypeArgs`.
     - Reassigns `genericParent` to the canonical parent.
     - Ensures `parent.genericInstances` contains **exactly** the canonical instances.
  2. Call the helper from both `canonicalize-resolved-types.ts` (post canonicalization of child nodes) and `CanonicalTypeTable.#copyMetadata` to keep runtime metadata in sync.
 3. Remove Optional-only dedupe shortcuts (`ensureOptionalAttachment`, etc.) once the generic path covers the same behavior; keep the functions but gate them behind assertions to confirm they’re no longer needed.
 4. Extend `collectOptionalConstructors` (or add a new diagnostic script) to assert that every optional instance is present in its parent list; fail fast if orphaned clones remain. Add a companion invariant that detects duplicate specializations (multiple instances with equivalent `appliedTypeArgs`) so the phase proves out the general reconciliation strategy.
- **Validation**
  - `npx tsx scripts/inspect-optional-constructors.ts` reports exactly one `Some` plus one `None` instance per specialization, zero orphan logs, and a single `(struct.new $Some…)` / `(struct.new $None…)` in wasm text.
  - `npx vitest run src/semantics/types/__tests__/map-recursive-union-canonicalization.test.ts` must pass with new duplicate-detection assertions enabled.
  - No Optional-specific escape hatches trigger under `CANON_DEBUG`; the helper reconciles arbitrary nominal generics (spot-check with at least one non-Optional generic in a unit test or instrumentation output).
- **Artifacts**
  - Updated canonicalization code plus reconciliation helper.
  - Document the new invariant in `docs/type-canonicalization-pass.md` (e.g., “Every nominal type’s canonical parent must enumerate all generic instances”).
- **Handoff**
  - Blocker: `npx tsx scripts/inspect-optional-constructors.ts` reports 15 `Some` nodes; `Some#144032.genericInstances` lists 12, missing `#7/#10/#11`.
  - `CANON_DEBUG=1` aborts via `assertCanonicalTypeRef` (`Map#146251#1` != `Map#146251#0`), so reconciliation still leaks non-canonical references.
  - Optional-specific shortcuts stay dormant; defer `Result`/`Promise` audits until the orphan sweep completes.
  - Wasm still emits `Some#499005#0/#13/#14/#15` (new calls 1/36/11/1), confirming duplicates.
  - Phase 3b (below) tracks the cleanup before entering Phase 4.

## Phase 3b – Optional Orphan Sweep
- **Goal**: Collapse remaining Optional orphans so `Some#144032.genericInstances` matches the constructor set and wasm emits a single `Some`/`None` pair. The solution *must* be general (not specific to `Some` / `None`)
- **Prep**
  - Run `npx tsx scripts/inspect-optional-constructors.ts` and stash the output in `docs/type-canonicalization-phase7-investigation.md`.
  - Use `CANON_DEBUG=1` (and optionally `CANON_TRACE_RECONCILE=1`) to capture orphan logs from `reconcileGenericInstances`.
  - Review `collectOptionalConstructors` and `canonicalize-resolved-types.ts` instrumentation so new assertions can trigger cleanly.
- **Execution**
  1. Instrument reconciliation to tag each orphan with the AST location that spawned it and log the three `Some#144032#7/#10/#11` cases.
  2. Trace the `Map#146251#0/#1` pair flagged by `assertCanonicalTypeRef`; ensure the registration site uses the canonical object from `resolveCanonicalObject` before pushing to `genericInstances`.
  3. Teach `collectOptionalConstructors` (or a sibling helper) to throw when a parent’s `genericInstances` diverge from the observed constructor set, gating behind `CANON_DEBUG` if noisy.
  4. After fixes, remove or guard the `ensureOptionalAttachment` shortcuts and confirm both canonicalization call sites see zero `reconcileGenericInstances` orphans.
- **Validation**
  - `CANON_DEBUG=1 npx tsx scripts/inspect-optional-constructors.ts` completes without `assertCanonicalTypeRef` errors and reports no missing Optional instances.
  - `npx tsx scripts/inspect-optional-constructors.ts` reports a single `Some` and `None` wasm struct definition with matching constructor counts.
  - `npx vitest run src/semantics/types/__tests__/map-recursive-union-canonicalization.test.ts` passes with orphan/duplicate assertions enabled.
- **Artifacts**
  - Updated canonicalization/reconciliation code plus any new debug utilities or failing-fast diagnostics.
  - Recorded inspector output in `docs/type-canonicalization-phase7-investigation.md` capturing the before/after orphan counts.
- **Handoff**
  - Highlight any remaining generic families that still bypass reconciliation once Optional is stable.
  - Call out any permanent instrumentation worth promoting to guard against future orphan regressions.

## Phase 4 – Metadata & Binaryen Cache Preservation
- **Goal**: Ensure Binaryen type caches (`binaryenType`, `originalType`) move to the canonical instance exactly once and orphaned clones never trigger new allocations.
- **Prep**
  - Inspect `CanonicalTypeTable.#copyMetadata` and `clearTypeCaches` to see when caches are cleared versus transferred.
- **Execution**
  1. Update metadata merging so caches are moved **before** we clear the losing instance; if both instances have caches, prefer the canonical one and log a warning (behind `CANON_DEBUG`).
  2. Reinforce that after canonicalization, no `Type` instance retains `binaryenType` unless it is the canonical representative.
  3. Add regression coverage in `map-recursive-union.e2e.test.ts` to inspect wasm text and assert the exact constructor count (should be 1 for `Some`, 1 for `None`).
- **Validation**
  - `npx tsx scripts/inspect-optional-constructors.ts` (verify constructor call counts in wasm text).
  - `npx vitest run src/__tests__/map-recursive-union.e2e.test.ts` (still acceptable if runtime trap persists; focus on constructor count assertions passing).
- **Artifacts**
  - Code changes plus updated tests.
  - `docs/type-canonicalization-phase7-investigation.md` – add “Phase 4 – Metadata Status” with before/after cache statistics.
- **Handoff**
  - Highlight any remaining wasm differences (function name sets, struct definitions).
  - Document the expected Binaryen cache ownership rules.

## Phase 5 – Wasm Determinism & Regression Guardrails
- **Goal**: Make wasm output deterministic across repeated compilations and re-enable the full regression suite.
- **Prep**
  - Ensure previous phases have eliminated orphan instances and duplicate constructors.
- **Execution**
  1. Re-run the e2e suite twice in succession; compare emitted wasm texts (focus on function/type name sets). If differences remain, trace back to the AST references still changing between runs and fix canonicalization accordingly.
  2. Tighten `map-recursive-union.e2e.test.ts` assertions so they diff entire wasm text sections (functions/types) rather than just counts.
  3. If any nondeterminism persists due to Binaryen internal ordering, document and, if necessary, normalize the output (e.g., sorting helper names before comparison).
- **Validation**
  - `npx vitest run src/__tests__/map-recursive-union.e2e.test.ts`
  - `npx vitest run src/__tests__/run-wasm-regression.e2e.test.ts`
- **Artifacts**
  - Updated tests and, if needed, deterministic normalization utilities.
  - `docs/type-canonicalization-plan-3.md` – add a “Determinism” section describing the final guardrails.
- **Handoff**
  - Confirm both key e2e suites are green; note any remaining flaky areas.
  - Provide links to comparison artifacts (e.g., stored wasm text samples) if helpful.

## Phase 6 – Final Verification & Cleanup
- **Goal**: Confirm the North Star, clean up instrumentation, and document the final state.
- **Prep**
  - Remove or disable temporary debug flags unless they provide ongoing value.
- **Execution**
  1. Run `npx vitest run` (entire suite) and `npm test` (if different) to ensure no regressions.
  2. Review instrumentation/diagnostic code added in earlier phases; keep it if it can run silently, otherwise strip or hide behind flags.
  3. Update `docs/type-canonicalization-phase7-investigation.md` with a “Final State” section summarizing:
     - Optional constructor counts.
     - Key wasm invariants.
     - Any known limitations.
  4. If new helper scripts/tests were added, document usage in `docs/type-canonicalization-pass.md`.
- **Validation**
  - All Vitest suites green.
  - `npx tsx scripts/inspect-optional-constructors.ts` shows stable canonical instance counts.
- **Artifacts**
  - Finalized documentation updates.
  - Any TODOs moved into the backlog (open GitHub issues, TODO comments, or plan appendices).
- **Handoff**
  - State explicitly that the North Star has been met (include command outputs).
  - Provide a short checklist for future regressions (e.g., “if Optional constructor count > 1, rerun Phase 3 reconciliation”).

---

## Additional Guidance
- **Working Branches**: If possible, commit after each phase to reduce merge conflicts and provide checkpoints.
- **Script Updates**: When modifying existing scripts (e.g., `inspect-optional-constructors.ts`), keep output stable so automated comparisons remain meaningful.
- **Communication**: Each phase should leave a short note in `docs/type-canonicalization-phase7-investigation.md` documenting progress, blockers, and decisions. This serves as the recovery log if the agent context resets mid-plan.
- **Contingencies**: If a phase uncovers a blocker that cannot be resolved within the phase scope, note it explicitly in the artifacts and create a new sub-phase (e.g., Phase 3b) before moving on. The next agent should begin with that blocker.

Following these phases sequentially should bring `test.voyd` back to a clean run without the illegal cast regression while leaving the canonicalization pipeline more robust for future generics.
