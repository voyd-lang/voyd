# Canonical Type Consolidation Pass

## Motivation

Type resolution currently creates many `Type` objects that are structurally identical but distinct by identity (e.g., separate `Map<RecType>` instances). Later stages still rely on object identity—casts, union matching, and runtime type checks compare `Type.idNum`. When two logically identical types diverge in identity, a value may pass static checks but fail at runtime (as in the `illegal cast` seen when matching `RecType`).

We need a post-resolution pass that walks the IR, deduplicates structurally equivalent types, and rewrites all references to share a single canonical instance.

## Objectives

1. Run after semantic resolution/inference so every expression already has an assigned `Type`.
2. Compute a stable structural fingerprint for each type and maintain a global canonical table.
3. Traverse the IR, replacing each `Type` reference with the canonical representative.
4. Make the pass idempotent, cycle-safe, and transparent to existing metadata (ancestor tables, method tables, etc.).

## Workflow Overview

### 1. Fingerprint computation
- Implement `typeKey(type: Type): string` that produces a stable hash of the type’s structure.
- Unwrap `TypeAlias` nodes to their target type when building the key.
- Nominal generics include the generic parent id and canonicalized keys for applied arguments.
- Structural types (tuples/structural objects) serialize fields/signatures; unions/intersections sort member keys to keep order-independent.
- Detect recursion with a memo/stack to emit repeatable cycle markers (e.g., `cycle:<id>`).

### 2. Canonical table
- Introduce `CanonicalTypeTable` (Map from fingerprint -> canonical `Type`).
- `getOrInsert(type)` canonicalizes children first, then either returns the existing representative or records the current instance as canonical.

### 3. IR traversal
- Add `canonicalizeResolvedTypes(module: VoydModule)` executed post-resolution.
- Walk modules, functions, impls, traits, expressions, and literals:
  * canonicalize `expr.type`, parameter types, return types, field types, applied type args, trait targets, etc.
  * reuse a visited set so each `Type` is processed once; reassign properties to the canonical instance.
- Ensure canonical instances already have their metadata resolved (ancestor tables, method lookup tables) before reuse.

### 4. Integration point
- After `checkTypes` completes (in `processSemantics`), run canonicalization so downstream codegen consumes canonical instances. Because the pass is idempotent, rerunning it in tests or tooling remains safe.
- The pass now runs on every build; no environment flag or override is required.
- The pass remains idempotent, so subsequent invocations detect that everything is already canonical.

### 5. Testing strategy
- Extend the existing regression (`test.voyd` / `map-recursive-union`) to confirm the illegal cast disappears once canonicalization is active.
- Write targeted unit tests constructing duplicate `Type` graphs, run the pass, and assert object identity convergence (`typeA === typeB`).
- Add an idempotence test—apply the pass twice and ensure no further changes occur.

## Fingerprint Format Reference
- `TypeAlias` fingerprints resolve to their target type; recursive aliases emit structural markers (`alias-cycle:<frameId>@<depth>`) so identical recursion graphs collapse even when aliases live under different modules.
- `UnionType` members are fingerprinted recursively, deduped, and sorted; recursive unions fall back to structural markers (`union-cycle:<frameId>@<depth>`).
- Nominal `ObjectType`/`TraitType` fingerprints include the generic parent id and the canonicalized fingerprints of applied arguments. Structural objects sort field fingerprints and include parent links.
- `FnType`, tuples, and fixed arrays serialize their child fingerprints in declaration order. Optional parameters are prefixed with `?`.
- Primitive and `Self` types keep their stable names, while all other residual nodes fall back to `<kind>#<id>` to guarantee uniqueness.

## Troubleshooting
- Run `scripts/report-type-fingerprint-collisions.ts` to list any duplicate fingerprints across the std library or a target module.
- Re-run `canonicalizeResolvedTypes` on a problematic module with a fresh `CanonicalTypeTable` to confirm the pass is idempotent and to inspect dedupe events.
- Execute `vitest run src/__tests__/map-recursive-union.e2e.test.ts` to validate that recursive alias scenarios continue to collapse to canonical forms.

## Audit Findings – Optional Constructors
- Instrumentation added in `canonicalize-resolved-types.ts` now logs whenever an optional constructor or alias survives in a non-canonical form. Running `npx vitest run src/semantics/types/__tests__/map-recursive-union-canonicalization.test.ts` emits repeated warnings such as:
  - `alias retained non-canonical target at Fn(get).appliedTypeArgs[0]` for the stdlib `Map`/`Array` helpers, showing that `Fn.appliedTypeArgs` still point at alias snapshots like `RecType#143181`.
  - `non-canonical Optional constructor detected at dedupeCanonicalInstances(Some#144032#…)` indicating that `ObjectType.genericInstances` continues to spawn fresh `Some` clones instead of reusing the shared instance.
- The initial crawler run (`collectOptionalSomeAudit`) over the canonicalized `map-recursive-union` module surfaced **15 distinct `Some#144032…` ids** hanging off `std::Map` implementations (see `src/semantics/types/__tests__/map-recursive-union-canonicalization.test.ts` for the reproduction). Those instances lived inside trait implementations for map iteration (`find`, `next`, `iterate`) and bucket helpers, confirming that optional constructors embedded in generic method metadata bypassed Phase 8 rewrites.
- The regression now enforces a single canonical `Some`/`None` instance for `RecType`, verifies that optional constructors keep their Binaryen caches after codegen, and fails fast if any audit crawler rediscovers duplicate heap ids.
- Follow-up work needs to (a) rewrite `Fn.appliedTypeArgs`, `genericInstances`, and trait method caches to the canonical objects and (b) merge Binaryen caches (`binaryenType` / `originalType`) so instrumentation stops flagging mismatched `T#… → RecType#…` aliases during canonicalization.

## Phase 4 Postmortem
- Re-enabled the wasm regressions (`src/__tests__/map-recursive-union.e2e.test.ts` and `src/__tests__/run-wasm-regression.e2e.test.ts`), keeping the runtime focused on the canonical Optional constructors.
- Added a wasm text guard that ensures only one `struct.new $Some#…` and `struct.new $None#…` survives in the compiled module, catching future duplication before execution.
- Fortified `src/semantics/types/__tests__/map-recursive-union-canonicalization.test.ts` with a Binaryen cache check so canonical `Some`/`None` retain `binaryenType` / `originalType` metadata even after codegen.
- Locked the regression crawler to expect a single Optional heap id, preventing silent regressions if canonicalization ever reintroduces duplicate constructors.

## Considerations

- Primitives, `Self`, and other singleton types already have unique identities; the pass can short-circuit for them.
- Skip or fully resolve any type still mid-resolution (e.g., `resolutionPhase < 2`) before canonicalizing.
- Memoize fingerprints to avoid quadratic recomputation for large unions.
- When canonicalizing unions/intersections, be careful to reuse the canonical union instance rather than rebuilding arrays, so downstream code sees the same object identity.

With this pass, all identical generic instantiations collapse to a single runtime type, eliminating mismatched casts stemming from divergent `Type` identities while preserving the rest of the pipeline unchanged.

test.voyd:
```
use std::all

pub type RecType = Map<RecType> | Array<RecType> | String

fn a() -> RecType
  Map([
    ("a", "b"),
  ])

pub fn main()
  let r = a()
  r.match(b)
    Map:
      b.get("a").match(v)
        Some:
          1
        else:
          -1
    else:
      -3
```
