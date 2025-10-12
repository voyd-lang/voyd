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
- Add a focused assertion in `map-recursive-union.e2e.test.ts` that verifies the `Map` constructor within the fixture ends up with the canonical `RecType` union argument.
- Extend the test to compile and run the `main` function from `mapRecursiveUnionVoyd`, asserting the numeric result (`1`) to lock in runtime behaviour.
- Introduce an executable regression (vitest or CLI harness) that compiles `test.voyd`, runs it via `runWasm`, and fails if the runtime throws.
- Capture the wasm text or binaryen type ids in a snapshot to ensure only a single `Map#...` struct is emitted after canonicalization.

### Phase 8 – Verification & Cleanup
- Run the full `npm test` suite plus manual `vt --run test.voyd` to confirm the illegal cast is gone.
- Audit the new contextual inference to make sure it doesn’t double-resolve functions without annotations or break closures capturing `self`.
- Update docs (`docs/type-canonicalization-pass.md`) with a short note about the contextual inference requirement and why it matters for recursive unions.

## Risks & Mitigations
- **Double resolution loops:** Guard `resolveFn` so we only re-enter bodies once; reuse existing `typesResolved` flags.
- **Overly eager inference:** Ensure we still support functions that purposely return broader types by checking compatibility before replacing inferred type args.
- **Test flakiness:** Running the wasm in tests can be slow; isolate the regression under a single targeted test to keep the suite reliable.
