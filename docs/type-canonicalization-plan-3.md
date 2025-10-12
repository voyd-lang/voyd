# Type Canonicalization Hardening Plan

## Why Another Pass?
- The optional constructor regression still reproduces as an illegal `ref.cast` when we run `vt --run test.voyd`. That program (mirrored in `src/__tests__/fixtures/map-recursive-union.ts`) builds a `Map<RecType>` where the union arm refers to an optional payload. At runtime the wasm traps because the map literal and the union constructor carry different `Some#…` heap ids.
- Even after the alias/optional canonicalization work (Phase 8), each code path retains its own `Some#…` / `None#…` object instance. Binaryen dutifully emits every variant it sees, so we end up with multiple struct definitions that should be identical.
- Codegen still just walks the `Type` objects provided by semantics. Because the AST caches pre-canonical types in places like `objectLiteral.type`, call `.type`, and `genericInstances`, Binaryen sees stale struct snapshots and duplicates the RTTs.
- The goal is to harden the type system so every resolved expression references the canonical `Type` graph. Once semantics guarantees that, Codegen can stay untouched and the wasm regression should stop failing.

- Current semantic pipeline already runs `canonicalizeResolvedTypes` after type checking, and Phase 8 collapsed alias fingerprints plus added optional-specific dedupe logic. However, the pass does not yet rewrite all expression fields or cached metadata, leaving stray pre-canonical objects in the AST.
- The wasm regression tests in `src/__tests__/map-recursive-union.e2e.test.ts` and `src/__tests__/run-wasm-regression.e2e.test.ts` remain skipped because the illegal cast is still triggered once the module executes.
- Binaryen heap type caching (`binaryenType`, `originalType`) is still scattered across both canonical and non-canonical instances, making it easy for later phases to pick up inconsistent references.

## Objectives
1. Ensure the canonicalization pipeline rewrites **all** AST references (expressions, fields, and metadata) to the canonical `Type` instances, including cached `binaryenType` handles.
2. Teach `CanonicalTypeTable` to preserve and merge metadata (binaryen caches, method tables, generics) when collapsing duplicates so the surviving instance is fully hydrated.
3. Re-run the regression coverage with wasm execution enabled to confirm the illegal cast is gone and that `Optional` constructors share a single heap type across the module.

## Strategy Overview
We stay entirely within semantics. The workflow is:
1. Amplify inspection/logging during canonicalization to surface any lingering non-canonical references.
2. Extend the canonicalization visitor so every node capable of holding a type (literals, calls, parameters, variables, unions, generics, etc.) points to the canonical object and drops stale caches.
3. Strengthen `CanonicalTypeTable.#copyMetadata` and dedupe hooks so cached Binaryen types and implementation metadata move onto the canonical node exactly once.
4. Once the AST is “clean”, re-enable the wasm regression assertions and add guard rails for optional constructor reuse.

## Work Breakdown

### Phase 1 – Canonicalization Coverage Audit
- Instrument `canonicalize-resolved-types.ts` with temporary assertions/logging to detect when an expression/type node still references a non-canonical `Some`/`None` or alias.
- Add a dedicated regression canary under `src/__tests__/semantics` (documented in `docs/type-canonicalization-pass.md`) that walks the post-canonicalization AST for `map-recursive-union` and fails if multiple distinct `Some#` ids remain. Wire the test up during the audit, prove it fails, then mark it `test.skip` / `test.todo` (or assert the failure explicitly) so the suite still passes until Phases 2–3 fix the root cause.
- Document any fields or metadata that currently escape the pass (e.g., `field.type`, `binaryenType`, `genericInstances`) to feed Phase 2.
- Capture the audit outcomes in `docs/type-canonicalization-pass.md` (new “Audit Findings – Optional Constructors” section) so later phases have a written reference.

### Phase 2 – Canonical Table Metadata Safety
- Update `CanonicalTypeTable.#copyMetadata` to:
  - Transfer `binaryenType`, `originalType`, `genericInstances`, and method tables from deduped objects/traits onto the canonical copy.
  - Clear or re-root `binaryenType` on the losing instance to avoid dangling pointers.
  - Maintain the parent/child links for generic instantiations without duplicating entries.
- Extend optional constructor handling so alias snapshots collapse onto the shared base object before any Binaryen cache is assigned.
- Add regression tests for metadata preservation (e.g., canonical `Some` retains its Binaryen type after dedupe).

### Phase 3 – AST Rewriting & Cache Sanitization
- Extend `canonicalize-resolved-types.ts` to:
  - Rewrite `expr.type`, `expr.inferredType`, `field.type`, `parameter.type`, `variable.type`, `objectLiteral.type`, `call.type`, `match` arms, and any cached `genericInstances` to the canonical object.
  - Include tuple/array/alias surfaces that Phase 1 flagged (`TupleType.value`, `FixedArrayType.elemType`, `TypeAlias.type`, etc.) so every cachey holder described in the audit is covered, not just optional constructors.
  - Clear outdated `binaryenType` fields on replaced objects to force consistent rebuilds.
  - When clearing caches, preserve the canonical instance’s `binaryenType`/`originalType` that Phase 2 already migrated—only wipe the stale copies on deprecated objects.
  - Ensure optional constructor instantiations reference the same canonical object as their union arm (no per-call clones).
- Add a semantic integration test that validates the canonical AST only contains a single `Some`/`None` instance id even across nested generics and map literals.

### Phase 4 – Runtime Revalidation
- Re-enable the skipped assertions in:
  - `src/__tests__/map-recursive-union.e2e.test.ts` (`wasm module executes main without trapping`).
  - The test defined in phase 1
  - src/__tests__/semantics/map-recursive-union-optional.audit.test.ts:49
- Add a quick regression asserting the canonical `Some`/`None` objects still expose the Binaryen caches Phase 2 re-homed (guard against Phase 3 over-clearing).
- Add a new check in that test (or a helper) that parses the emitted wasm text and asserts only one `struct.new $Some#…` and `struct.new $None#…` appear.
- Run `npx vitest run src/__tests__/run-wasm-regression.e2e.test.ts` and the broader recursive/MsgPack fixtures, updating snapshots as needed once the runtime stabilizes.
- Capture a small postmortem in `docs/type-canonicalization-pass.md` summarizing the semantic rewrite and the new regression guard rails.

### Phase 5 – Optional Instance Canonicalization Fix
- Isolate the remaining `Some#…` / `None#…` duplicates by extending the Phase 3 crawler to dump every `genericParent` / `genericInstances` edge for Optional constructors (map the exact creation site for `Some#144032#0/#7/#14/#15`).
- Update `resolveObjectType` / `registerGenericInstance` so Optional constructors are never cloned per-call: prefer reusing the canonical `Some`/`None` instance when `appliedTypeArgs[0]` already matches the target union.
- Harden `canonicalTypeTable.attachInstanceToParent` and the optional-specific dedupe path so:
  - `genericParent` always points at the canonical base object.
  - `genericInstances` is de-duplicated by reference before returning, guaranteeing a single entry per `Some<T>` instantiation.
  - Any “losing” duplicate has its `binaryenType`, `originalType`, and `genericInstances` cleared to avoid reintroduction during subsequent passes.
- Add a targeted semantic test that reprocesses `map-recursive-union` and asserts `Some.genericParent.genericInstances` only contains the canonical `RecType` specialization (ideally living alongside the current optional constructor regression suite).
- Re-run the wasm text inspection to ensure the struct emitter now reports a single `$Some#…` / `$None#…` definition before moving on.

### Phase 6 – Codegen / Runtime Alignment
- Audit every callsite that can materialize Optional helpers (trait dispatch, iterator utilities, closure emissions) and force eager compilation of the backing functions so Binaryen never requests RTTs for stale clones—extend the new `compileFunction` guard with focused tests that assert no new wasm functions are emitted when a module is compiled twice.
- Add a regression that compiles `map-recursive-union` and walks the Binaryen module to confirm no `iterate#…` or `Some#…` functions/structs are duplicated; fail fast when unexpected suffixes (`#7/#14/#15`) appear.
- Ensure `canonicalize-resolved-types` wipes any residual `binaryenType` on non-canonical Optional constructors immediately after they are re-pointed to the base instance so codegen cannot observe stale caches.

### Phase 7 – Final Regression & Cleanup
- Re-run the full e2e matrix (`map-recursive-union`, `run-wasm-regression`, MsgPack suites, VSX smoke) with wasm execution enabled and update snapshots or fixture expectations where canonical ids shift.
- Capture the resolved optional canonicalization story in `docs/type-canonicalization-pass.md` (new “Optional Constructor Postmortem” subsection) including the final invariants around `genericInstances`, Binaryen caches, and wasm text guards.
- Remove any temporary logging/assertions introduced in Phases 5–6 once the regression suite passes green.
- Submit a final diff review checklist covering semantics (canonicalization + table), codegen (function compilation ordering), tests, and documentation so Phase 4 outcomes remain locked in.

## Risks & Mitigations
- **Hidden metadata leaks:** Binaryen caches scattered on old instances can be easy to miss. Mitigation: audit `ObjectType` and `TraitType` properties and add assertions that stale instances never hold `binaryenType` after canonicalization.
- **Performance regressions:** More aggressive canonical rewrites could re-run Binaryen type synthesis more often. Mitigation: preserve existing caches on the canonical node and reuse them when available.
- **Test churn:** Canonical ids may shift when duplicate instances collapse. Snapshot tests should be updated incrementally with clear commentary.

## Definition of Done
- The canonicalization pass guarantees a single object instance per logical constructor and preserves all metadata on the canonical node.
- Wasm execution tests for `map-recursive-union` and `run-wasm-regression` pass without traps.
- New regression coverage monitors both the AST (no duplicate `Some` ids) and the wasm text (no duplicated `struct.new $Some#…`).
- Documentation (plan & pass notes) reflects the new canonicalization guarantees and testing expectations.
