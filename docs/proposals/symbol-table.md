# Symbol Table Specification

Status: Draft  
Owner: Compiler Architecture Working Group  
Scope: `src_next/binder`

## Overview

The symbol table is the canonical source of truth for lexical bindings, modules, type declarations, and macros in the redesigned compiler pipeline. It replaces the ad‑hoc `lexicon` maps currently stored on syntax objects and enables later phases—type inference, effect analysis, and code generation—to query symbol metadata without mutating the AST.

The table is constructed during the binder phase after macro expansion. It consumes the expanded AST and emits:

- A scope graph describing lexical nesting.
- Symbol records for every name that can be referenced downstream.
- Import/export metadata for module resolution.
- Snapshots that allow speculative binding (e.g., macro hygiene or interactive tooling) without touching the core data.

## Terminology

- **NodeId**: Stable identifier assigned to each AST node during parsing. Used for diagnostics and cross-referencing.
- **Scope**: Lexical region in which names can be introduced. Examples: module, function, block, trait, macro body.
- **ScopeId**: Unique identifier for a scope entry in the table.
- **Symbol**: A named entity (value, type, trait, module, macro, parameter, etc.).
- **SymbolId**: Unique identifier for a symbol record.
- **TypeSchemeId**: Handle for type schemes stored in the `TypeArena`. Referenced here for cross-phase communication.
- **Snapshot**: Persistent view of the table that can be restored to support speculative operations.

## Design Goals

1. **Purity**: Once built, the table is an immutable read-only structure. Mutations happen during construction only.
2. **Separation of concerns**: AST nodes remain immutable; all symbol-related data lives in the table.
3. **Incremental friendliness**: Snapshots allow the binder to branch, e.g., when expanding macros or during IDE features.
4. **Rich metadata**: Each symbol can carry arbitrary metadata (visibility, trait constraints, documentation ids).
5. **Determinism**: Given the same expanded AST, symbol IDs and scope structure must be stable.

## Data Model

```text
ScopeGraph
  ├─ ScopeInfo{id, parent, kind, owner}
  └─ edges form a tree rooted at `rootScope`

SymbolIndex
  ├─ SymbolRecord{id, name, kind, declaredAt, scope}
  └─ name lookup per-scope supports shadowing and overloading

Snapshot
  └─ frozen copy of scopes + symbols + allocation cursors
```

### Scope Kinds

| Kind      | Description                                              |
|-----------|----------------------------------------------------------|
| module    | Top-level file or inline `mod` block                     |
| function  | Function body, including closures                        |
| block     | Local block with its own let-bindings                    |
| impl      | Trait implementation scope                               |
| trait     | Trait declaration scope                                  |
| macro     | Compile-time macro body scope (after expansion)          |

### Symbol Kinds

| Kind           | Description                                      |
|----------------|--------------------------------------------------|
| value          | Local/global variable or constant                |
| parameter      | Function parameter                               |
| type-parameter | Generic type parameter                           |
| type           | Nominal type alias or object definition          |
| trait          | Trait declaration                                |
| impl           | Implementation symbol (methods recorded separately) |
| module         | Module definition                                |
| macro          | Functional macro definition                      |

## API

```ts
type NodeId = number;
type ScopeId = number;
type SymbolId = number;
type TypeSchemeId = number;

type ScopeKind = "module" | "function" | "block" | "impl" | "trait" | "macro";
type SymbolKind =
  | "value"
  | "parameter"
  | "type-parameter"
  | "type"
  | "trait"
  | "impl"
  | "module"
  | "macro";

interface ScopeInfo {
  /** Opaque handle used to reference this scope. */
  id: ScopeId;
  /** Parent scope or null for the root module. */
  parent: ScopeId | null;
  /** Lexical classification of the scope (module, function, ...). */
  kind: ScopeKind;
  /** NodeId of the AST node that introduced this scope (e.g., Fn node). */
  owner: NodeId;
}

interface SymbolRecord {
  /** Unique symbol identifier. */
  id: SymbolId;
  /** Human-readable name; stored in canonical form. */
  name: string;
  /** Symbol classification used for downstream dispatch. */
  kind: SymbolKind;
  /** NodeId where the symbol was declared (for diagnostics). */
  declaredAt: NodeId;
  /** Scope in which the symbol resides. */
  scope: ScopeId;
  /** Optional type scheme assigned during type inference. */
  scheme?: TypeSchemeId;
  /** Arbitrary metadata (visibility, doc ids, trait bounds). */
  metadata?: Record<string, unknown>;
}

interface SymbolTable {
  /** Root scope id (always a module). */
  readonly rootScope: ScopeId;
  /** Allocate a new child scope. */
  createScope(info: Omit<ScopeInfo, "id">): ScopeId;
  /** Push the traversal cursor to `scope` (affects implicit declare/resolve). */
  enterScope(scope: ScopeId): void;
  /** Pop the current traversal cursor to its parent. */
  exitScope(): void;
  /** Register a symbol definition under the current scope. */
  declare(symbol: Omit<SymbolRecord, "id" | "scope">): SymbolId;
  /** Resolve the nearest symbol with `name` visible from `fromScope`. */
  resolve(name: string, fromScope: ScopeId): SymbolId | undefined;
  /** Resolve all overloads visible from `fromScope` (stable order). */
  resolveAll(name: string, fromScope: ScopeId): readonly SymbolId[];
  /** Retrieve an immutable snapshot of a symbol record. */
  getSymbol(id: SymbolId): Readonly<SymbolRecord>;
  /** Retrieve scope metadata. */
  getScope(id: ScopeId): Readonly<ScopeInfo>;
  /** Iterate symbols declared directly within a scope. */
  symbolsInScope(id: ScopeId): Iterable<SymbolId>;
  /** Capture the current table state for speculative work. */
  snapshot(): SymbolTableSnapshot;
  /** Restore to a previously captured snapshot. */
  restore(snapshot: SymbolTableSnapshot): void;
}

interface SymbolTableSnapshot {
  nextScope: ScopeId;
  nextSymbol: SymbolId;
  scopes: readonly ScopeInfo[];
  symbols: readonly SymbolRecord[];
  /** Optional user metadata (e.g., import resolution cache). */
  payload?: Record<string, unknown>;
}
```

### API Notes

- `enterScope`/`exitScope` are conveniences for binder traversal. The table does **not** maintain an implicit stack; callers must balance the operations.
- `resolveAll` preserves declaration order within the nearest scope and then walks outward. This deterministic order is critical for overload selection.
- `snapshot` cloning is optimized via structural sharing; only allocation cursors and modified buckets are copied.

## Usage in the Pipeline

1. **Binder**: walks the expanded AST, creating scopes and declaring symbols. Each AST node stores only its `NodeId`; all binding data is external.
2. **Type Checker**: attaches `TypeSchemeId` values back onto symbol records via `metadata.scheme`, leaving the AST untouched.
3. **Effect Analysis**: stores per-function effect rows in `metadata` without impacting other consumers.
4. **Codegen**: queries the table to retrieve symbol metadata, such as visibility or trait associations.

## Invariants

- Every symbol’s `scope` refers to an existing `ScopeInfo`.
- Scope parent chains eventually terminate at `rootScope`.
- `resolve(name, scope)` returns the same symbol ID regardless of lookup path, provided the scope graph is unchanged.
- Snapshots can be restored at any time; doing so discards mutations since the snapshot but must leave earlier handles valid.

## Error Handling

- Duplicate declarations in the same scope should raise binder diagnostics but still record the first definition to preserve downstream behavior.
- Shadowing across scopes is allowed; `resolve` always picks the nearest definition.
- Attempting to `exitScope` when the stack is empty is a fatal binder bug.

## Future Extensions

- **Multifile incremental builds**: snapshots can be persisted to disk to avoid rebinding untouched modules.
- **IDE integration**: the table can expose symbol ranges and documentation handles via the `metadata` map without changing the core API.
