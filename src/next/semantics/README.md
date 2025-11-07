# `src/next/semantics`

Semantic analysis for the redesigned Voyd compiler lives here. The folder groups
phases 3–5 of the proposed pipeline (binder → HIR lowering → type analysis) so
that incremental development and testing can happen without touching the legacy
compiler.

```
src/next/semantics
├── binder          // scope graph + symbol table
├── hir             // high-level IR nodes and builder utilities
├── typing          // type arena + type table surface area
└── ids.ts          // shared opaque identifier aliases
```

## Phase overview

1. **Binder (`binder/`)** traverses the expanded AST and produces a
   `SymbolTable`. The table is immutable once construction finishes and is the
   authoritative record for scopes, imports/exports, and metadata such as type
   schemes.
2. **HIR lowering (`hir/`)** rewrites AST nodes into stable, macro-free
   high-level IR nodes. Expression and statement IDs remain stable between runs,
   enabling downstream caches to reference semantics without touching syntax
   objects.
3. **Typing (`typing/`)** hosts the `TypeArena` (interns canonicalized types and
   type schemes) and the `TypeTable` (maps HIR IDs back to `TypeId`s). The arena
   intentionally avoids holding AST nodes so it can be reused by later phases
   like effect analysis and MIR lowering.

For background see `docs/compiler-rearchitecture.md` and the language guides in
`reference/basics.md` + `reference/types/`.

## Binder and `SymbolTable`

* `binder/types.ts` defines `ScopeKind`, `SymbolKind`, `SymbolRecord`, and the
  `SymbolTable` interface. The table is queried by symbol/Scope IDs rather than
  syntax references.
* `binder/symbol-table.ts` implements the API with a persistent snapshot
  mechanism. It exposes `declare`, `resolve`, `symbolsInScope`, and
  `snapshot/restore`, making it straightforward to build incremental tooling
  (macro hygiene, IDE previews, etc.).
* `createSymbolTable({ rootOwner })` seeds the root scope (usually the module
  node). Binder passes should call `enterScope`/`exitScope` during traversal and
  keep diagnostics outside the table to preserve purity.

## HIR structure

* `hir/nodes.ts` enumerates node/statement/expression variants that matter to
  type inference: literals, identifiers, calls, blocks, control flow, object
  literals, and assignments. Each node stores the originating `NodeId` plus a
  `SourceSpan` for diagnostics.
* `hir/builder.ts` offers a minimal `HirBuilder` that allocates stable `HirId`s,
  keeps `Map`s of statements/expressions, and surfaces `finalize()` to freeze a
  `HirGraph`. Lowering passes can remain pure by constructing builders locally
  and then returning the graph snapshot.

## Typing components

* `typing/type-arena.ts` provides a simple but fully functional arena:
  canonicalization via structural hashing, helpers for primitives/nominals/
  structural objects/functions/unions/intersections, and scheme creation +
  instantiation. `freshTypeParam()` hands out opaque `TypeParamId`s so inference
  doesn’t rely on AST identities.
* `typing/type-table.ts` records the association between `HirExprId` →
  `TypeId` and `SymbolId` → `TypeSchemeId`. It is deliberately tiny to encourage
  specialized query helpers in future phases.

The arena currently ships a placeholder `unify` implementation (pointer
equality). When richer inference lands, extend `unify`, `widen`, and the
constraint machinery; `TypeTable` consumers do not need to change.

## Development notes

- Keep functions pure where possible. Builders expose mutation-friendly APIs
  but always return cloned snapshots so callers can treat results as immutable.
- Prefer early returns to nested `if/else` blocks (matches the project style
  guide).
- Tests for these components should live under `src/next/__tests__` (or deeper
  subfolders) and use Vitest: `npx vitest src/next/...`.
- `reference/types` documents the full type system surface area; refer to it
  when adding new type descriptors or trait interactions.
- Avoid reaching back into syntax objects once the binder runs. All later phases
  should rely on `SymbolTable`, HIR nodes, or `TypeTable`.
