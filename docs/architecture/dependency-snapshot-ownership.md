# Dependency snapshot ownership

The compiler's dependency snapshot cache retains completed semantics for
non-`src` modules so repeated SDK compiles can reanalyze application source
without rebuilding unchanged standard-library and package modules.

## Ownership contract

The cold commit is canonical cache state. It is immutable after commit and is
kept behind `ReusableDependencySemanticsSnapshot.restore`; callers cannot read
its semantic map. Every restore creates one mutable working graph with a fresh
type arena, effect interner, semantic result, and module-local store clones.

Within one restored graph, all references to the same logical store must agree.
In particular, `binding.symbolTable` and the internal semantic symbol-table
reference are identical, and every `binding.dependencies` edge points to the
matching binding result in that restored graph. A restored graph never points
to the canonical graph or another restore's mutable state.

Only parser-owned syntax objects are shared. Semantic analysis treats them as
immutable source inputs. HIR, binding state, typing state, borrowing results,
diagnostics, and export metadata are snapshot-owned and restored independently.

Cache hits are working copies and must never be committed as a new cold
snapshot. `commitDependencySnapshot` accepts only a miss produced by a cold
analysis.

## Retained object inventory

The snapshot restore boundary owns these mutable or lazily hydrated domains:

- the shared type arena and effect interner, plus each module's effect table;
- public and internal symbol-table references;
- binding scopes, declarations, overloads, imports, module-member indexes, and
  the rewired dependency binding graph;
- HIR maps and nodes, with typing stores rebound to the restored HIR;
- type tables, function/object/trait/type-alias stores, primitive caches,
  instance caches, type-argument and call-resolution maps, trait implementation
  indexes, member metadata, and diagnostics;
- borrowing mutation summaries, guard targets and plans, mutable-storage sets,
  and diagnostics;
- module export entries and the complete nested package semantic interface;
- module-level diagnostics and the immutable symbol index rebuilt from the
  restored symbol table.

Adding a retained semantic field requires adding it to the explicit restore
path and extending the isolation regression. A shallow spread is not a valid
snapshot implementation for a field containing objects, arrays, maps, sets, or
mutable store instances.

## Invalidation boundary

The key includes the compiler snapshot schema version, test-overlay mode,
dependency roots, and a stable fingerprint for every non-`src` module. Module
fingerprints include identity, path, origin, source, source files, package root,
dependencies, and macro exports. Additions, removals, content changes, root
changes, semantic test mode, and compiler snapshot schema changes therefore
invalidate the entry. A dynamic package-root resolver disables reuse because
its external state cannot be fingerprinted safely.

Application source and import spelling are outside the key. Application
modules are always recomputed against a restored dependency graph, so wildcard,
selected, and aliased imports can share the same dependency snapshot when they
load the same dependency modules.

## Borrowing durability

There is no durable borrowing-result cache to restore. Scoped-borrow work
removed those artifacts and their SDK APIs. The durable cross-package boundary
is `PackageSemanticInterface`: a finite, symbol-arena-independent value stored
inside export metadata. Snapshot restore clones that interface recursively;
borrowing dependency projections are rebuilt or weakly cached per restored
semantic result. Caller-local borrowing paths, worklists, and transient
analysis state are never serialized into the interface.
