# Type Canonicalization Reboot – Plan 5

## Project Goal
Deliver a robust, maintainable type system for Voyd’s hybrid nominal + structural language. The pipeline must compile programs like `test.voyd` without illegal casts, even when unions span recursive object graphs or mix nominal and structural variants.

## Background
- The previous “Phase 5 incomplete” commit (`e6bb294fb646bc0a92160d5a9797ebe2a57aeebe`) injected aggressive canonicalization/metadata rewrites across codegen and semantics; those changes correlate with Binaryen traps (`Assertion failed: isRef()`) and invalid wasm modules (`ref.cast` mismatches).
- `canonicalizeResolvedTypes` currently mutates the AST after resolution, but never converges—new `Some#…` / `Map#…` clones appear faster than the pass can normalize them, and codegen re-registers the losers.
- Optional constructor audits (`npx tsx scripts/inspect-optional-constructors.ts`) still report 12 distinct `Some` heap types plus 1 `None`, showing canonical Optional instances fragment.
- Union lowering relies on compiling every union arm to the base object type (`$Object#16`). The wasm text for `test.voyd` (`vt --emit-wasm-text --opt test.voyd`) demonstrates repeated `struct.new $Some#144054#13`/`ref.cast` sequences, so any lapse in canonical identities produces the illegal casts we observe.
- End-to-end coverage (`map-recursive-union.e2e.test.ts`, `run-wasm-regression.e2e.test.ts`) fails hard; we need to pin these failures before refactoring.

## Guiding Principles
- **Roll back first.** Remove the `e6bb294fb646` changes (especially AST mutation and codegen cache hacks) before building new infrastructure.
- **Lock regressions in tests.** Create north-star fixtures—including two structurally identical recursive types plus a third overlapping union variant—to document the failure and track progress with `test.skip`/`test.todo`.
- **Intern types at creation.** Replace post-hoc canonicalization with a global interner powered by `typeKey`, similar to Rust’s `TyCtxt` or TypeScript’s checker pools.
- **Metadata belongs to canonicals.** Binaryen caches, trait lookup tables, and generic instance lists must live on canonical handles only.
- **Deterministic wasm is non-negotiable.** Each phase should preserve or improve determinism in emitted wasm text; the union lowering must no longer produce divergent heap ids for identical payload shapes.

## Phase Breakdown

### Phase 0 – Roll Back Regression Commit
- **Goal:** Remove the high-risk changes introduced in `e6bb294fb646` and restore the pre-phase-5 baseline.
- **Work:**
  1. Delete or revert the diffs under `src/codegen.ts`, `src/codegen/compile-call.ts`, `src/codegen/compile-closure.ts`, `src/codegen/rtt/method-accessor.ts`, and `src/semantics/types/canonicalize.ts` introduced by that commit.
  2. Update any headers/docs referencing the experimental behaviour.
  3. Confirm `npm test` matches the earlier failure pattern (Binaryen trap + wasm validator errors) so we know we are back to the previous baseline.
- **Deliverables:** Clean worktree without the regression code, notes added to `docs/type-canonicalization-phase7-investigation.md`.

### Phase 1 – Baseline Snapshot & Union Audit
- **Goal:** Capture the exact failure state (post-rollback) and inspect union lowering.
- **Work:**
  - Run `npx vitest run src/__tests__/map-recursive-union.e2e.test.ts` and `npx vitest run src/__tests__/run-wasm-regression.e2e.test.ts`; document stack traces, optional constructor counts, and wasm validation errors under a “Phase 1 Baseline” entry in `docs/type-canonicalization-phase7-investigation.md`.
  - Emit wasm text with `vt --emit-wasm-text --opt test.voyd`; summarize the union lowering pattern (top-level `$Object#16`, multiple `Some#…` heap ids, repeated `ref.cast` checks) in both the investigation doc and `docs/type-canonicalization-pass.md`.
  - Hash or otherwise record the relevant wasm text fragments for future comparisons.
- **Deliverables:** Updated docs with the baseline and union audit, no code edits beyond instrumentation toggles.

### Phase 2 – Lock Guiding North-Star Tests
- **Goal:** Encode today’s failures as explicit regression tests, then skip them with TODOs so future phases re-enable them deliberately.
- **Work:**
  1. Introduce a dedicated fixture exercising:
     - Two structurally identical recursive types.
     - A third recursive union that overlaps with the first two but adds an extra object arm.
     - A runtime scenario matching `test.voyd` (map literal, match, optional unwrap).
  2. Extend `src/__tests__/map-recursive-union.e2e.test.ts` (or add a sibling suite) to run the new fixture and assert on:
     - Canonical identity (currently failing).
     - Wasm execution (currently failing).
     - Optional constructor counts.
  3. Wrap failing assertions in `test.skip` / `test.todo` with comments referencing the phase responsible for re-enabling them.
  4. Add snapshots (or golden summaries) for union lowering so future phases can diff wasm payloads deterministically.
- **Deliverables:** New fixtures/tests committed, failures recorded via skipped tests, all suites still pass overall.

### Phase 3 – Remove Post-Hoc Mutation Pass
- **Goal:** Convert `canonicalizeResolvedTypes` into a pure validator and delete mutation-specific plumbing.
- **Work:**
  1. Strip metadata rewrites (`adoptObjectMetadata`, orphan snapshots, `clearTypeCaches`, iteration loops) from `canonicalize-resolved-types.ts`.
  2. Update consumers (`processSemantics`, debug helpers) to treat canonicalization as an optional validation step.
  3. Delete dead helpers/utilities now unused after the rollback.
  4. Ensure `CANON_DEBUG` instrumentation remains available but read-only.
  5. Refresh docs describing the canonicalization pass to emphasize its new “validate only” role.
- **Deliverables:** Lean validator pass, code references cleaned, documentation updated.

### Phase 4 – Introduce the Type Interner
- **Goal:** Provide a central `TypeStore` (or revamped `CanonicalTypeTable`) that interns structures at creation time.
- **Work:**
  1. Define an interner API keyed by structural fingerprints (leveraging `typeKey`) with cycle-safe handling.
  2. Integrate the interner into all type creation sites (object literals, unions, optionals, trait instantiation, contextual inference).
  3. Remove `ObjectType.clone`’s `#iteration` suffix and redirect `registerGenericInstance` to the interner so duplicates never materialize.
  4. Add unit tests verifying identity reuse for identical structures and stability for recursive graphs.
- **Deliverables:** Interner implementation, constructor callsites updated, green semantic/unit tests.

### Phase 5 – Rewire Generic Instantiation & Metadata
- **Goal:** Ensure generic instances and metadata (Binaryen caches, method tables) belong exclusively to canonical handles.
- **Work:**
  1. Replace remaining clone-based generic instantiation logic with interner lookups.
  2. Centralize Binaryen cache ownership on canonical instances; purge caches from losers at registration time.
  3. Update optional constructor collectors and diagnostics to rely on canonical handles.
  4. Extend tests to assert that `genericParent.genericInstances` only contains canonical references.
- **Deliverables:** Stable generic metadata model, updated documentation on ownership rules.

### Phase 6 – Align Codegen With Canonical Handles
- **Goal:** Ensure codegen consumes canonical types exclusively and no longer introduces divergent heap ids.
- **Work:**
  1. Remove `ensureCanonicalObjectInstance`/trait equivalents and rely on interner-produced handles.
  2. Simplify `mapBinaryenType` caching; fix union lowering so identical payload shapes share heap ids.
  3. Re-run optional constructor audits, capturing expected counts in tests.
  4. Confirm emitting wasm twice from the same module yields identical type/function sets.
- **Deliverables:** Simplified codegen, deterministic wasm output, updated regression coverage.

### Phase 7 – Re-enable Canonicalization Guards & E2E Tests
- **Goal:** Turn the skipped tests back on and demonstrate that illegal casts are resolved.
- **Work:**
  1. Gradually re-enable assertions in the map-recursive-union suite (constructor counts → wasm determinism → runtime execution).
  2. Re-enable `run-wasm-regression.e2e.test.ts` once `validate()` passes.
  3. Update `docs/type-canonicalization-pass.md` and the investigation log with final state, residual risks, and guidance.
  4. Remove TODOs/skips, run `npx vitest run` and `npm test`, and capture final wasm text snapshots for posterity.
- **Deliverables:** All suites green, wasm runtime validated, documentation refreshed.

## Supporting Notes
- Maintain `CANON_DEBUG` instrumentation through Phases 3–6 for surgical diagnostics; ensure it is silent when unset.
- Any temporary skips must reference the responsible phase so future contributors can clear them deliberately.
- Keep updating `docs/type-canonicalization-phase7-investigation.md` as phases progress—especially after union or optional constructor milestones.
