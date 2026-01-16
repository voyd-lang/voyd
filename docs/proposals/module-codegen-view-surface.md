# Narrow `ModuleCodegenView` Surface (Remove `BindingResult` From Codegen)

Status: Implemented
Owner: Compiler Architecture Working Group
Scope: `packages/compiler/src/semantics/codegen-view/*`, `packages/compiler/src/codegen/*`, pipeline and tests

## Goal

Make `ProgramCodegenView` a true boundary by removing direct access to semantics/binding internals from codegen.

## Problem

`ModuleCodegenView` currently exposes `binding: BindingResult`, which enables codegen to:

- read import wiring (`binding.imports`),
- read effect declarations (`binding.effects`),
- read package metadata (`binding.packageId`, `binding.isPackageRoot`),
- append diagnostics (`binding.diagnostics`).

This “responsibility bleed” makes the boundary porous and increases the chance of correctness bugs when binding representation changes.

## Proposal

### Replace `binding: BindingResult` With Codegen-Oriented Metadata

Introduce `ModuleCodegenMetadata` (names bikeshedable) owned by semantics but shaped for codegen:

```ts
type ModuleCodegenMetadata = {
  moduleId: string;
  packageId: string;
  isPackageRoot: boolean;
  imports: readonly {
    local: SymbolId;
    target?: { moduleId: string; symbol: SymbolId };
  }[];
  effects: readonly {
    name: string;
    operations: readonly {
      name: string;
      resumable: "resume" | "tail";
      symbol: SymbolId;
    }[];
  }[];
};
```

Then change `ModuleCodegenView` to:

```ts
type ModuleCodegenView = {
  moduleId: string;
  meta: ModuleCodegenMetadata;
  hir: HirGraph;
  effects: EffectTable;
  types: ModuleTypeIndex;
  effectsInfo: EffectsLoweringInfo;
};
```

Codegen reads `ctx.module.meta.*` instead of `ctx.module.binding.*`.

### Semantics-Owned Import Wiring Index

To avoid repeated ad-hoc scans, expose a stable import wiring index on `ProgramCodegenView`:

- `imports.getLocal(moduleId: string, target: SymbolRef): SymbolId | undefined`
- `imports.getTarget(moduleId: string, local: SymbolId): SymbolRef | undefined`

This becomes the only supported way for codegen to map between local and imported symbols.

### Semantics-Owned Effect Declarations and Global Effect IDs

Codegen currently computes `effectIdOffset` by summing `binding.effects.length` in module iteration order.

Long-term, the boundary should define a deterministic global effect id assignment owned by semantics:

- `program.effects` provides:
  - stable module iteration order,
  - `effectGlobalId` for each `(moduleId, localEffectIndex)`,
  - operation addressing shape for perform sites.

This prevents accidental non-determinism from codegen-side ordering.

## Migration Plan (Single PR)

1. Add `ModuleCodegenMetadata` and populate it in `buildProgramCodegenView`.
2. Replace all `ctx.module.binding.*` uses in codegen with `ctx.module.meta.*` and/or `program.imports`.
3. Remove `BindingResult` from `ModuleCodegenView`.
4. If needed, add a temporary adapter layer during refactor, but delete it before landing (no hybrid end state).

## Success Criteria

- Codegen does not import `BindingResult` or access `binding.*` through the boundary.
- Import wiring and effect declarations are available through `ProgramCodegenView`-owned indexes.
- All tests pass.
