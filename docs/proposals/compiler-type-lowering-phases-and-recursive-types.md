# Compiler Type Lowering Phases + Recursive Type Support

Status: Implemented
Owner: Compiler Architecture Working Group
Scope: `packages/compiler/src/codegen/*`, `packages/compiler/src/semantics/lowering/*`, `packages/compiler/src/semantics/typing/type-arena.ts`, `docs/proposals/type-arena.md`

## Goal

Make the compiler’s type/lowering/codegen boundary more explicit and robust by:

- Separating “signature lowering” from “runtime RTT/method-table construction”.
- Making recursive types (especially recursive type aliases) a first-class concern in the type arena (interning + substitution).
- Clarifying closure capture rules so imports and type-level symbols cannot accidentally become runtime captures.

This proposal is motivated by failures that only appear under larger stdlib features (e.g. a `Map<T>` implementation that depends on closures, generics, and string hashing).

## Current State (Problems)

### 1) Codegen phase coupling (signature vs runtime RTT)

Some call sites need only a Wasm signature (params/result), but today type-to-wasm lowering can eagerly trigger:

- Runtime type registry entries
- Structural RTT layout computation
- Trait method table assembly that requires other metadata to be registered first

This introduces ordering hazards (e.g. “missing metadata for trait method impl …”) and makes metadata registration fragile.

### 2) Recursive type aliases are not first-class in `TypeArena`

Recursive aliases like:

```
type RecType = Box<RecType> | None
```

are supported by typing, but the arena does not model “recursive types” explicitly. Downstream operations like substitution and interning can fall into cycles unless every consumer is defensive.

### 3) Closure capture analysis can select non-value symbols

Capture lowering should only capture runtime values (locals/params/closures). If imported symbols (or other non-runtime declarations) are treated as captures, codegen can be forced to represent “a function symbol” as a runtime value inside an environment, which breaks generic handling and increases RTT pressure.

## Proposal

### 1) Introduce an explicit “type lowering mode” API boundary

Create two public lowering APIs with a strict contract:

- `wasmSignatureTypeFor(typeId, ctx) -> binaryen.Type`
  - Must be pure: no RTT registry writes, no structural layout computation, no method-table lookups.
  - May conservatively lower all reference-ish types to a single `anyref`/`eqref`/`ref null` base (depending on backend constraints).
- `wasmRuntimeTypeFor(typeId, ctx) -> binaryen.Type`
  - May allocate runtime type ids, structural layouts, closure env types, method tables, etc.

Implementation guidance:

- Keep a single implementation if desired, but the *default* for metadata registration and ABI surfaces must be the “signature” path.
- Enforce the contract by splitting modules:
  - `codegen/signature-types.ts` (no dependency on RTT/method-table builders)
  - `codegen/runtime-types.ts` (may depend on RTT)
  - `codegen/types.ts` can remain as a façade, but call sites must be explicit about which path they’re using.

Success criteria:

- `registerFunctionMetadata` and `registerImportMetadata` never require that trait impl metadata already exists.
- Reordering codegen phases does not change correctness (only affects caching/perf).

### 2) Make runtime RTT/method-table construction an explicit pass

Add a dedicated step after metadata registration and before body compilation:

1. Register all function/import metadata (signature-only lowering).
2. Build runtime RTT artifacts:
   - Enumerate reachable runtime types (from function bodies, match patterns, field/method access sites, closure envs).
   - Construct structural RTT layouts and trait method tables.
3. Compile function bodies (now safe to assume RTT is available).

Notes:

- This can start as a “lazy but ordered” approach: store pending work in registries during compilation, then finalize after all contexts are visited. The key requirement is that RTT creation is not triggered during metadata registration.
- This pass should also be the place to reject unsupported runtime features in a controlled way, instead of throwing from deep inside `wasmTypeFor`.

### 3) Add first-class recursive type support to the arena

Extend `docs/proposals/type-arena.md` and the implementation to explicitly represent recursive types.

Proposed arena variant (one possible shape):

```ts
type RecursiveType = {
  kind: "recursive";
  binder: TypeParamId;
  body: TypeId;
};
```

Rules:

- A recursive alias instantiation allocates a `binder` and builds `body` where self-references use `type-param-ref(binder)`.
- Substitution must treat `recursive` as a binder: substitutions that include `binder` must not substitute under the binder (standard capture-avoidance rule).
- Interning keys must be recursion-aware (i.e. hashing must not infinitely recurse when encountering `recursive` / `type-param-ref` cycles).

Benefits:

- Consumers can reason about recursion explicitly instead of relying on accidental placeholder behavior.
- Substitution/unification/intersection handling can be implemented once, correctly, and reused everywhere.

### 4) Formalize closure capture eligibility

Define capture eligibility as a property of the binding site:

Capturable:

- locals
- parameters
- closure values (lambda symbols)

Not capturable:

- imported symbols (they are statically addressable)
- type-level declarations (objects/traits/type aliases)
- module-level functions (call by symbol ref, not by env capture) unless explicitly lowered as first-class values

Implementation guidance:

- Add a predicate like `isCapturableValue(symbolRecord)` in `semantics/lowering/captures.ts`.
- If/when first-class function values are added, represent them explicitly in HIR/lowering as a distinct value kind, rather than “capturing the symbol”.

## Testing Plan

Add compiler regression tests that:

- Compile a fixture where a closure references an imported stdlib function and ensure capture lowering does not include the import.
- Compile a fixture with cross-module trait impls and ensure codegen does not depend on metadata registration order.
- Compile recursive aliases (generic + non-generic) and run substitution-heavy typing paths without stack overflow.
- Add a “no RTT in signature phase” invariant test by asserting runtime type registry is empty (or unchanged) immediately after metadata registration.

## Migration

1. Introduce signature/runtime API split while keeping behavior identical.
2. Move metadata registration call sites to signature-only lowering.
3. Add (or refactor into) a runtime RTT build step; initially only builds what is currently being built lazily.
4. Add `recursive` to the type arena (or equivalent recursion-aware representation).
5. Update docs (`docs/proposals/type-arena.md`) and migrate consumers incrementally behind feature flags if needed.

## Risks / Tradeoffs

- Adding a `recursive` descriptor touches many call sites (unification, pretty-printing, hashing, RTT ids). The payoff is long-term: recursion becomes a supported invariant, not an emergent property.
- Splitting type lowering increases surface area but reduces “hidden side effects” and ordering bugs.
- A dedicated RTT pass needs a clear reachability story (what types are “runtime visible”), but even a conservative over-approximation is better than order-dependent crashes.
