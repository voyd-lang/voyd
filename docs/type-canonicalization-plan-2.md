# Type Canonicalization Finish Line Plan

## Current Blocker
- The `RecType` regression still fails because contextual return typing never reaches calls inside function bodies. In `src/semantics/resolution/resolve-fn.ts` the body is resolved with `resolveEntities` without passing the annotated return type through `resolveWithExpected`. As a result, the `Map([...])` constructor in `test.voyd` keeps the inferred `Map<String>` instantiation and the union arm expects `Map<RecType>`.
- Canonicalization now dedupes structural duplicates, but it cannot reconcile different generic arguments. The runtime still traps (`ref.cast` → illegal cast) because the map literal and the union arm point at different runtime type ids (`Map#146273#0` vs `Map#146273#1`).
- Our current tests only assert that the alias unwraps; they never inspect the instantiated call type or execute the wasm. We need end-to-end coverage that fails when contextual inference is missing.

## Objectives
1. Feed annotated return types into expression resolution so generic constructors inside a function body see the expected type and choose the correct instantiation.
2. Extend regression coverage to assert that `Map([...])` inside `make_map`/`a` resolves to `Map<RecType>` and that the compiled wasm executes without trapping.
3. Guard canonicalization against regressions by verifying it runs after the new inference step without re-introducing duplicate ids.

## Work Breakdown

### Phase 5 – Contextual Return Inference
- Update `resolveFn` (and `resolveClosure` if needed) to pass `resolveWithExpected` the annotated return type before resolving the body’s final expression. Ensure we only apply this when the function has an explicit return type so inference-based functions keep existing behaviour.
- If the body is a block, thread the expected type into the last expression before `resolveBlock` caches it. Consider a helper to share logic between functions and lambdas.
- Re-run the `inferCallTypeArgs` path to confirm that `call.getAttribute("expectedType")` is populated before generic inference. Add assertions/logging during development to prove the expected type is present for `Map.init`.

### Phase 6 – Alias Fingerprint & Canonical Table Fixes
- Update `typeKey` so alias fingerprints incorporate the canonicalized target structure rather than the alias identity, ensuring `RecType` and `MsgPack` collapse once their unions match.
- Adjust `CanonicalTypeTable` to prefer the canonical union representative when different aliases resolve to the same fingerprint; double-check metadata copying so shared instances keep method/trait data intact.
- Add targeted unit coverage around alias-equivalent unions (e.g., `RecType` vs `MsgPack`) to prevent regressions and confirm the new fingerprinting behaviour.

### Phase 7 – Regression Hardening
- Completed: instrument `map-recursive-union.e2e.test.ts` to assert the `Map` constructor resolves to `Map<RecType>`, execute the compiled wasm, and snapshot the emitted `Map#...` struct id.
- Completed: add `run-wasm-regression.e2e.test.ts` that shells through `runWasm(test.voyd)` and fails on runtime traps.
- Outstanding: both end-to-end tests still abort with an illegal cast even though the canonical `Map` id now matches. Root cause is duplicated optional variants (`Some#...`) that survive canonicalization and clash at runtime.

### Phase 8 – Optional/Some Canonicalization
- Extend alias fingerprinting so `Optional<RecType>` collapses with `Optional<String>` when their canonical element types match.
- Ensure `typeKey` normalises applied generic arguments after contextual inference so cached `Some<T>`/`None<T>` instances reuse a single canonical id.
- Update `CanonicalTypeTable` dedupe heuristics to merge option constructors and reassign method/field metadata without losing trait bindings.
- Add focused unit coverage around `Optional` to prevent future divergence (e.g., compare `Some<RecType>` vs `Some<String>`).

### Phase 9 – Runtime Revalidation
- Re-run `map-recursive-union.e2e.test.ts` and `run-wasm-regression.e2e.test.ts` once optional canonicalization lands; both must execute `main` without traps.
- Scrape the wasm text for duplicate `Some#`/`Optional#` struct ids and snapshot the canonical set to guard against regressions.
- Double-check other recursive fixtures (`recursive-union.e2e.test.ts`, `msg-pack` encoder/decoder) for new dedupe behaviour; add assertions if they surfaced fresh ids.

### Phase 10 – Verification & Cleanup
- Run the full `npm test` suite plus manual `vt --run test.voyd` to confirm the illegal cast is gone.
- Audit the contextual return threading to ensure we don’t re-resolve generic impls or leak alias arguments into unrelated functions.
- Update docs (`docs/type-canonicalization-pass.md`) with a summary of the contextual inference plus optional dedupe work and add guidance on writing regression tests that execute wasm.

## Risks & Mitigations
- **Double resolution loops:** Guard `resolveFn` so we only re-enter bodies once; reuse existing `typesResolved` flags.
- **Overly eager inference:** Ensure we still support functions that purposely return broader types by checking compatibility before replacing inferred type args.
- **Test flakiness:** Running the wasm in tests can be slow; isolate the regression under a single targeted test to keep the suite reliable.
- **Alias churn:** Collapsing optionals may ripple into msgpack/iter tests; snapshot the relevant ids and adjust fixtures incrementally instead of bulk-updating wasm text.
