# Prompt 1: Binding and Lowering (visibility data + exports)

Context:
- read apps/reference/visibility.md
- Current model only tracks `"module"`/`"public"` (see `packages/compiler-next/src/semantics/hir/nodes.ts` and `binding/parsing.ts`).
- Object fields/methods have no visibility metadata; `api`/`pri` are parsed but ignored semantically.
- Exports/imports are filtered only on `"public"` and do not distinguish package vs. API nor the package root (`pkg.voyd`).

Goals:
- Extend `HirVisibility` (and decl tables) to encode module-private, package-visible, and public API; add member-level visibility including object-private (`pri`) and api-exportable.
- Parse and carry `api`/`pri` on fields and impl methods; normalize `pub` at top level to “package-visible” (not auto-exported).
- Track package identity and the package root module (`pkg.voyd`); only allow level-3 exports from the root.
- Update binding/import resolution to enforce: same module sees level 1; same package sees level 2+; other packages only see level 3; emit diagnostics for out-of-scope imports/uses.
- Lowering should preserve the richer visibility on items/fields/methods/exports.

Success criteria:
- New/updated unit tests in `packages/compiler-next/src/semantics/__tests__/binding.test.ts` (and/or new fixtures) that:
  - Parse and bind `api`/`#` members, capturing correct visibility on fields/methods.
  - Reject cross-package `use` of non-exported modules/items; allow same-package `pub` imports.
  - Ensure only `pkg.voyd` can create public API exports.
- HIR snapshot updates (e.g., `__snapshots__/pipeline.test.ts.snap`) reflect new visibility shapes.
- All binding/lowering tests pass: `npx vitest packages/compiler-next/src/semantics/__tests__/binding.test.ts packages/compiler-next/src/semantics/__tests__/lowering.test.ts`.

---

# Prompt 2: Typing and Access Control

Context:
   read apps/reference/visibility.md
- Typing currently ignores visibility; field access, object literals, and structural typing expose all members.
- Imports expose full object shapes; non-`api` members aren’t stripped for cross-package consumers.

Goals:
- Enforce access rules during typing:
  - `pri` members accessible only within the owning obj/impl.
  - Non-`api` members hidden from other packages; package-visible members usable inside the package.
  - `api` members usable across packages only if the type and member are exported via `pkg.voyd`.
- Object literal construction and destructuring should respect visibility (cannot construct another package’s type with hidden/non-`api` fields).
- Imported types should surface only allowed members; structural shapes for external types should exclude non-`api`.
- Add visibility-aware diagnostics for invalid accesses/imports.

Success criteria:
- Add typing tests under `packages/compiler-next/src/semantics/typing/__tests__/` covering:
  - Field/method access success/failure across module/package boundaries.
  - Object literal construction failing when hidden fields are required externally.
  - Imported types exposing only `api` members; non-`api` access emits a diagnostic.
  - Trait/impl member visibility preserved.
- Run typing suite: `npx vitest packages/compiler-next/src/semantics/typing/__tests__`.

---

# Prompt 3: Codegen and Public API Emission

Context:
- Codegen currently exports any `"public"` function item to WASM; this will leak package-internal `pub` items.
- Function metadata/import metadata don’t account for the richer visibility levels.

Goals:
- Align WASM exports with level-3 (public API) only; respect `index.voyd` export list.
- Ensure imported function metadata still resolves for API-visible items while blocking internal ones.
- Consider member exports (methods/fields) only when exported via `index.voyd`.

Success criteria:
- Add/adjust pipeline tests (`packages/compiler-next/src/__tests__/pipeline-api.test.ts` or new) to ensure:
  - Package-internal `pub` items are not exported to WASM.
  - Items exported via `pkg.voyd` are exported and callable.
- Run end-to-end tests: `npx vitest packages/compiler-next/src/__tests__`.
