# Type Canonicalization Phase 7 – Investigation

## Summary
- Re-running the wasm regression still traps with `RuntimeError: illegal cast`, and four of the `map-recursive-union` e2e guards fail because duplicate Optional constructors survive Binaryen lowering.
- Phase 7’s goal (“reattach orphaned Optional instances and make Binaryen reuse the canonical heap ids”) is not met. After canonicalization there are still multiple `Some#…` objects for the same specialization, and they are **not** re-registered under the canonical parent.
- These orphaned Optionals leak into codegen, yielding 46 `struct.new $Some#…` calls (expected 1) and non-idempotent function name sets, so we continue chasing the same runtime failure.

## Phase 0 – Rollback Snapshot (2025-10-13)
- Reverted commit `e6bb294fb646` to remove Binaryen cache mutations and post-hoc AST rewrites in codegen/canonicalization.
- `npx vitest run src/__tests__/map-recursive-union.e2e.test.ts` now reproduces the earlier failure pattern:
  - `RuntimeError: illegal cast` when executing `main`.
  - Map struct snapshot mismatch (`Map#146251#0` emitted vs expected `Map#146251#2`).
  - Optional helper guards report duplicated iterator helpers (`iterate#…` suffixes) and nondeterministic function sets.
- `npx vitest run src/__tests__/run-wasm-regression.e2e.test.ts` fails with the same `RuntimeError: illegal cast`, confirming the wasm module remains invalid at runtime.
- These results match the pre-phase-5 baseline, providing a clean starting point for the type interner work in Plan 5.

## Phase 1 – Baseline Snapshot (2025-10-13)
- Collected fresh e2e failures immediately after the rollback baseline:
  - `npx vitest run src/__tests__/map-recursive-union.e2e.test.ts` fails 3/7 guards. The wasm execution trap surfaces as `RuntimeError: illegal cast` (`wasm:/wasm/0002848e:1:21097 → src/__tests__/map-recursive-union.e2e.test.ts:302`). The duplicate helper assertion logs fifteen iterator helpers (`iterate#147658#0 … iterate#147658#11`). The determinism check reports 270 functions on the first compile vs 755 on the second (`src/__tests__/map-recursive-union.e2e.test.ts:405`).
  - `npx vitest run src/__tests__/run-wasm-regression.e2e.test.ts` reproduces the same `RuntimeError: illegal cast` (`wasm:/wasm/0002848e:1:21097 → run src/run.ts:14`).
- Optional constructor audit (`npx tsx scripts/inspect-optional-constructors.ts`):
  - Canonical AST still carries **12** `Some#144032#…` instances and **1** `None#144037`.
  - Union participation count remains **14**, signalling that every recursive Optional arm reappears during lowering.
  - Binaryen heap stats echo this: `Some#498987#7` (36 constructor calls), `Some#498987#14` (11), `Some#498987#0` (1), and `None#498992` (71).
- Union lowering snapshot:
  - `vt --emit-wasm-text --opt test.voyd > tmp/test-phase1.wat` captures four distinct Optional struct definitions layered on top of `$Object#16` (`$Some#144054#0/#7/#14`, `$None#144059`).
  - The `main` body repeatedly performs `__extends(144054, …)` on the `$Object#16` base then `ref.cast` into the active `$Some#144054#…` variant before unboxing (see `tmp/test-phase1.wat:2238` and `tmp/test-phase1.wat:2260`).
  - File hash `b47ef00b9bba2e93f6545b6d171537a97a9b29d1  tmp/test-phase1.wat` recorded for later diffing.
- No source edits were made—worktree stayed clean after running the commands above.

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

## Phase 2 – Canonical Reference Coverage Audit (Plan 4)

### Summary
- Extended `canonicalize-resolved-types` so function generic instances, implementation method tables, trait method lists, and cached call metadata (`expectedType`, `parameterFnType`, `inferredElemType`) all resolve through `canonicalTypeRef`.
- Added `assertCanonicalTypeRef` under `CANON_DEBUG` to fail fast when a lookup does not resolve to the canonical node; no violations fired during the current run.
- New unit coverage exercises the added surfaces (function generics, closure caches, trait/impl methods) to ensure their identities converge on the canonical instances.

### Validation
- `npx vitest run src/semantics/types/__tests__/canonicalize-resolved-types.test.ts`
- `npx vitest run src/__tests__/map-recursive-union.e2e.test.ts` (still failing at the known optional regression, but no new errors surfaced).

### Coverage Map
| Field / Cache                                                                      | Canonicalization Hook                                                 |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `Fn.genericInstances[*].returnType` / `inferredReturnType` / `annotatedReturnType` | `canonicalizeFn` iterates instances and re-applies `canonicalTypeRef` |
| `Implementation.methods`                                                           | `canonicalizeImplementation` walks each method function               |
| `TraitType.methods`                                                                | `canonicalizeTypeNode` for trait nodes                                |
| `Call.type` / `Call.fn` / `Call.expectedType` attribute                            | `canonicalizeExpr` call branch                                        |
| `Closure.parameterFnType` attribute                                                | `canonicalizeClosure`                                                 |
| `ArrayLiteral.inferredElemType` attribute                                          | `canonicalizeExpr` array literal branch                               |

### Open Questions
- `expectedType` attributes set on non-call expressions remain rare; continue to watch for other attribute keys that may cache types outside the audited set.

### Handoff Notes
- Remaining uncertainty: cached attributes attached by downstream passes (`parameterFnType` on non-closure expressions, potential Binaryen caches) still merit a follow-up audit while reconciling generic instance metadata in Phase 3.
- The coverage map above can seed a regression checklist; any new fields added to the AST should be appended here and routed through `canonicalTypeRef`.

## Phase 3 – Generic Instance Reconciliation (Plan 4)

### Summary
- Introduced `reconcileGenericInstances` and invoked it from both the canonicalization pass and `CanonicalTypeTable.#copyMetadata`, ensuring canonical parents rebuild their `genericInstances` arrays and merge clones sharing identical `appliedTypeArgs`.
- Added a lightweight alias facility to `CanonicalTypeTable` so orphan instances collapse to their canonical representative on subsequent lookups; the canonicalization pass now reruns automatically whenever reconciliation drops orphans.
- Hardened `collectOptionalConstructors` to fail fast when an optional specialization is missing from its parent list, while still tolerating legacy clones that point to the same canonical `appliedTypeArgs`. The script now reports the canonical Optional graph without tripping the orphan guard.

### Instrumentation Snapshot (CANON_TRACE_OPTIONAL_REGISTRATION=1, CANON_TRACE_RECONCILE=1)
- `ObjectType.registerGenericInstance` logs show the semantic resolver (`resolveGenericsWithTypeArgs`) registers **16** `Some` specializations in sequence (`Some#144032#0…#15`), with `instanceCount` incrementing on every call—so the duplicates are fully attached to `Some#144032` when they are created.
- During canonicalization, `reconcileObjectGenericInstances` repeatedly prunes `Some#144032.genericInstances` down to **12** canonical entries (`#0, #1, #3, #4, #5, #6, #8, #9, #12, #13, #14, #15`). The pass never reattaches the dropped clones (`#7`, `#10`, `#11`), leaving them as AST-local orphans even though their `genericParent` still points at `Some#144032`.
- The final inspector output confirms the mismatch: “Some constructors in canonical AST: 15” versus “Base Some#144032 generic instances (12)”, and the missing ids line up with the clones trimmed by the reconciling pass. This pins the orphan creation on the canonicalization stage (lossy reconciliation), not on semantic instantiation.

### Validation
- `npx tsx scripts/inspect-optional-constructors.ts`
- `npx vitest run src/semantics/types/__tests__/map-recursive-union-canonicalization.test.ts`

### Open Questions
- We still materialize multiple Optional constructor ids (15 `Some`, 1 `None`) because wasm emission has not been normalized yet; the remaining wasm constructor count regression is expected to be addressed in Phase 4.
- Binaryen struct statistics (`struct.new` totals) remain inflated, indicating follow-up work is required once metadata reconciliation propagates through codegen.
- Even after aliasing raw clones to their canonical parents, `scripts/inspect-optional-constructors.ts` still reports orphan optional objects (`Some#144032#7/#10/#11`) because scoped blocks retain the old instances; we need a follow-up sweep to replace those block-local references so the inspector sees exactly one `Some`/`None` per specialization.

### Handoff Notes
- New helper: `src/semantics/types/reconcile-generic-instances.ts`; canonicalization relies on it, and the canonical type table registers orphan aliases automatically.
- Debugging aids: set `CANON_TRACE_RECONCILE=1` to log reconciliation inputs/outputs; the optional constructor script now emits detailed sibling listings if it encounters any gaps.
- New instrumentation: set `CANON_TRACE_OPTIONAL_REGISTRATION=1` to trace `ObjectType.registerGenericInstance` calls for Optional constructors (payload includes prior parents, applied type args, and a trimmed stack); use `CANON_TRACE_GENERIC_REGISTRATION=1` to lift the filter and log every generic registration site.

## Phase 4 – Standalone Interner Snapshot (2025-04-03)
- Added `TypeInterner` plus a resolver harness that routes every resolved type through the new interner by piggybacking on the validator’s traversal. The module records alias mappings only; metadata reconciliation remains deferred to later phases.
- Running the harness against `run-wasm-regression.voyd` observes **1 319** type visits, produces **236** canonical handles, and logs **1 083** reuse events. The raw fingerprint set currently spans **133** unique entries (mostly Optional/Map specialisations), giving us a quantitative baseline before wiring the interner into semantics.
- New coverage:
  - `src/semantics/types/__tests__/type-interner.test.ts` asserts that recursive unions and structural clones reuse the same handles and that applied type args point back at the canonical union.
  - `src/__tests__/type-interner.e2e.test.ts` runs the harness on the wasm regression fixture, asserts the stats above, and documents that `runWasm(run-wasm-regression.voyd)` still throws `RuntimeError: illegal cast`. The latter keeps the runtime failure visible while the interner remains out-of-band.
- The validator (`canonicalizeResolvedTypes`) now accepts an `onType` callback so the harness can reuse the existing traversal without copying its logic. This hook is intentionally opt-in to avoid mutating modules during normal semantics runs.

## Phase 3b – Optional Orphan Sweep
- `reconcileObjectGenericInstances` now records an orphan snapshot on every losing instance (id/key/applied args plus parent chain) and tags the canonical survivor. We reuse that metadata in both the canonicalizer and downstream tooling.
- Union canonicalization aggressively normalises optional children: every optional branch is reconciled against its canonical parent, aliased in the type table, and replaced in-place so no union retains a stale clone.
- `collectOptionalConstructors` consumes the orphan snapshot. When it encounters an alias, it rewrites the instance back to the canonical parent’s registered child before emitting it in the result sets, guaranteeing that inspector counts match `genericInstances`.
- Codegen now respects the orphan snapshot as well. `ensureCanonicalObjectInstance` prefers the canonical instance recorded during reconciliation, so Binaryen never re-registers dropped clones.

### Validation (2025-10-12)
- `npx tsx scripts/inspect-optional-constructors.ts`

  ```
  Some constructors in canonical AST: 12
  None constructors in canonical AST: 1
  Base Some#144032 generic instances (12): Some#144032#0, Some#144032#1, Some#144032#12, Some#144032#13, Some#144032#14, Some#144032#15, Some#144032#3, Some#144032#4, Some#144032#5, Some#144032#6, Some#144032#8, Some#144032#9
  Optional constructor edges:
    Some#144032 -> [Some#144032#0, Some#144032#1, Some#144032#12, Some#144032#13, Some#144032#14, Some#144032#15, Some#144032#3, Some#144032#4, Some#144032#5, Some#144032#6, Some#144032#8, Some#144032#9]
  ```

- `CANON_DEBUG=1 npx tsx scripts/inspect-optional-constructors.ts` completes without `assertCanonicalTypeRef` failures. Orphan diagnostics still log (by design) while the command succeeds.
- `npx vitest run src/semantics/types/__tests__/map-recursive-union-canonicalization.test.ts`

## Phase 4 – Metadata Status (2025-10-13)
- Canonical metadata merges now move Binaryen caches (`binaryenType`, `originalType`) before clearing aliases. `CanonicalTypeTable` exposes `#transferTypeCaches` and `#clearTypeCaches`, so every reuse path lifts caches onto the canonical instance and wipes the loser immediately afterwards.
- `reconcile-generic-instances` and `canonicalize-resolved-types` respect the new ownership contract: if both sides already hold caches we keep the canonical values and log conflicts behind `CANON_DEBUG`.
- New guardrails:
  - Non-canonical instances no longer retain `binaryenType`; both the table and the pass clear fields and attributes once the alias is registered.
  - Under `CANON_DEBUG`, conflicting cache merges surface warnings with the participating type ids.
- Added wasm regression coverage (`map-recursive-union.e2e.test.ts`) that parses struct definitions and verifies each Optional payload shape (`i32`, object/union, array, string) corresponds to a single wasm heap type; it also checks the generated constructor calls stay within that set.
- Validation snapshot (`npx tsx scripts/inspect-optional-constructors.ts`):

  | Measurement                         | Before Phase 4           | After Phase 4           |
  | ----------------------------------- | ------------------------ | ----------------------- |
  | Canonical AST `Some` constructors   | 12                       | 12                      |
  | Canonical AST `None` constructors   | 1                        | 1                       |
  | Wasm `struct.new $Some#…` totals    | 36 / 11 / 1 (per id)     | 36 / 11 / 1 (unchanged) |
  | Wasm `struct.new $None#…` totals    | 71                       | 71                      |
  | Optional struct definitions in wasm | 4× `Some#…`, 1× `None#…` | unchanged               |

  The cache work prevents freshly-created aliases from reintroducing extra heap ids, but existing optional permutations still materialise distinct Binaryen structs because their field payload types differ. We need a follow-up reconciliation pass to funnel those generics through the canonical heap id.

- Binaryen cache ownership rules (post Phase 4):
  1. Only canonical `Type` instances may carry `binaryenType`/`originalType`.
  2. When deduping, move caches onto the canonical node, warn (under `CANON_DEBUG`) if both sides disagree, then wipe the loser.
  3. `clearTypeCaches` is idempotent and safe to call whenever an alias is registered; callers do not need to guard on structural type kind beyond object/fixed-array.
- Optional struct audit: parsing the emitted wasm struct definitions shows four `Some` payload variants remain, but each is structurally distinct:
  - `Some#144032#0` → `value: i32`
  - `Some#144032#13` → `value: (ref null $Object#16)` (map/union payloads)
  - `Some#144032#14` → `value: (ref null $Array#…)`
  - `Some#144032#15` → `value: (ref null $String#…)`
  `None#…` appears once with a reused heap id. The e2e guard now ensures we keep exactly one struct per payload shape (rather than erroneously forcing a single Optional struct).

### Remaining Risk / Next Focus
- Optional generics still compile to four distinct wasm struct definitions (`Some#…#0/#13/#14/#15`) plus `None#…#0`. Each maps to a different payload family (i32, base object/union, array, string), so the follow-up work should focus on coalescing only truly identical payloads rather than forcing a single Optional heap id.
- Wasm constructor counts remain inflated (36/11/1 `Some`, 71 `None`). The new e2e guard fails as expected; once cache normalisation propagates through codegen the test should flip green.
- Orphan snapshot metadata continues to provide useful diagnostics; keep it (gated by `CANON_DEBUG`) until we can prove the optional sweep is exhaustive.
