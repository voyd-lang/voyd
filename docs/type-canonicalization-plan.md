# Canonical Type Pass Recovery Plan

## Current Status And Pain Points
- The canonicalization pass is wired into the semantic pipeline but causes identity collisions for unrelated union instances (e.g. `RecType` vs `MsgPack`) because `typeKey` collapses recursive aliases too aggressively.
- `CanonicalTypeTable` is deduping unions before all children have been fully normalized, so structurally different graphs can hash to the same fingerprint.
- Invoking the pass during isolated unit tests surfaced ordering assumptions (the pass now runs before type checking) and produced confusing failures in std libraries.

These combined issues made the “illegal cast” regression test fail and broke unrelated std checks. We need a disciplined approach before attempting the integration again.

## Objectives
1. Restore confidence in the fingerprinting logic so structurally distinct types never collide.
2. Ensure the canonical table only dedupes after all child nodes are canonicalized and metadata is safe to reuse.
3. Reintroduce the pass after resolution without disrupting semantic phases or existing tests.
4. Add regression and diagnostic coverage that will catch the previously observed failures.

## Work Breakdown

### Phase 1 – Fingerprint Audit
- **Catalog existing keys:** Instrument `typeKey` to log fingerprints for representative recursive unions (RecType, MsgPack, Optional) collected from real modules.
- **Identify collisions:** Build a small diagnostic harness that runs resolution on the std library and reports duplicate fingerprints across aliases/named unions.
- **Refine cycle markers:** Update `typeKey` so cycles include stable alias ids _and_ depth markers; verify the new scheme discriminates `RecType` vs `MsgPack`.
- **Unit coverage:** Write focused tests for `typeKey` covering recursive aliases, distinct unions with similar shapes, and generics with differing parents.

### Phase 2 – Canonical Table Stability
- **Child-first canonicalization:** Adjust `CanonicalTypeTable#getOrInsert` to canonicalize children before hashing the parent. Add guards to skip dedupe when any child is still visiting.
- **Metadata preservation:** Confirm canonical representatives carry method tables, resolution flags, and lexicon references intact. Add assertions that reused nodes are fully resolved.
- **Safety instrumentation:** Temporarily record when two structurally equal types dedupe to the same instance; inspect a few samples manually to ensure expectations match reality.
- **Targeted tests:** Extend `canonicalize-resolved-types.test.ts` with scenarios covering: duplicate unions imported across modules, trait/object instantiations with alias args, and the recursive map regression.

### Phase 3 – Pipeline Integration
- [x] **Re-run semantic phases manually:** Added `scripts/run-canonicalization-phase.ts`, which walks resolution outputs for entries like `test.voyd` and `std/map.voyd` (or custom paths) and applies canonicalization with optional type checking.
- [x] **Order validation:** Canonicalization now runs immediately after `resolveEntities` and before `checkTypes`, matching the pass design so type checking consumes canonical instances. The reasoning is documented inline with the integration.
- [x] **Gradual wiring:** The pass is gated via `VOYD_CANONICAL_TYPES`/`VOYD_ENABLE_CANONICAL_TYPES` (or test overrides) so we can flip it on without affecting default builds.
- [x] **E2E verification:** Replaced the wasm runtime check with `map-recursive-union.e2e` diagnostics that prove the pass unwraps `RecType` aliases inside `Map<RecType>` and meaningfully reduces canonicalization work when the feature flag is enabled.

### Phase 4 – Finalization
- [x] **Enable by default:** Canonicalization now runs automatically inside `processSemantics`, and the `VOYD_CANONICAL_TYPES`/`VOYD_ENABLE_CANONICAL_TYPES` toggles along with their overrides were deleted.
- [x] **Clean out instrumentation:** Removed the `typeKey` tracing harness and related CLI flags so no transient logging remains in production builds.
- [x] **Document the pass:** Expanded `docs/type-canonicalization-pass.md` with the finalized architecture, fingerprint breakdown, and troubleshooting guidance.
- [x] **Regression suite expansion:** Updated the `map-recursive-union` e2e coverage to compare a pre-pass baseline against the canonicalized pipeline, keeping the regression locked in.

## Lessons Learned
- **Don’t tweak core fingerprints blindly.** The initial attempt simplified cycle markers and inadvertently caused collisions between distinct aliases (`RecType` vs `MsgPack`). We need concrete fixtures and assertions before touching hashing logic.
- **Child nodes must be canonical first.** Deduping parents while children still reference pre-canonical instances leads to mismatched metadata and runtime type confusion.
- **Integration order matters.** Running the pass before type checking exposed latent assumptions in the std library. We should validate phase ordering in isolation before updating the global pipeline.
- **Instrumentation saves time.** Lightweight diagnostic tooling (logging fingerprints, diffing canonical ids) would have highlighted the erroneous dedupes immediately; we’ll build these as part of the recovery effort.

With this plan, we can iterate safely: fix fingerprinting, stabilize dedupe, verify in isolation, and only then re-enable the pass globally.
