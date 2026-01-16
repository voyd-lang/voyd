# Boundary DTOs for `ProgramCodegenView` (No Typing Internals in Public Shapes)

Status: Implemented
Owner: Compiler Architecture Working Group
Scope: `packages/compiler/src/semantics/codegen-view/*`, `packages/compiler/src/codegen/*`, tests

## Goal

Prevent the “stable boundary” (`ProgramCodegenView`) from depending on semantics/typing internal data structures.

## Problem

Even if codegen only imports `ProgramCodegenView`, the boundary currently re-exports typing-internal shapes (e.g. object templates, trait impl records). This couples codegen to typing implementation details and makes refactors hazardous.

## Proposal

### Define DTO Types Inside `semantics/codegen-view/*`

Create codegen-facing data transfer object (DTO) types that:

- use only stable primitives (`TypeId`, `SymbolId`/`SymbolRef` or `ProgramSymbolId` when available),
- do not expose typing store internals,
- are immutable (`readonly`) and deterministic in iteration order.

Examples (sketch):

```ts
type CodegenObjectTemplate = {
  owner: SymbolRef; // or ProgramSymbolId
  fields: readonly { name: string; type: TypeId; optional: boolean; mutable: boolean }[];
  methods: readonly { name: string; symbol: SymbolId }[];
};

type CodegenTraitImplInstance = {
  implSymbol: SymbolId;
  traitSymbol: SymbolId;
  forType: TypeId;
  methods: readonly { traitMethod: SymbolId; implMethod: SymbolId }[];
};
```

### Module Codegen Metadata and Program Indexes

The boundary should also expose DTOs for module-level wiring and effect identity,
so codegen never reaches into binding internals:

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

type ImportWiringIndex = {
  getLocal(moduleId: string, target: SymbolRef): SymbolId | undefined;
  getTarget(moduleId: string, local: SymbolId): SymbolRef | undefined;
};

type ProgramEffectIndex = {
  getOrderedModules(): readonly string[];
  getGlobalId(moduleId: string, localEffectIndex: number): number | undefined;
  getByGlobalId(
    effectId: number
  ): { moduleId: string; localEffectIndex: number } | undefined;
  getEffectCount(): number;
};
```

These DTOs must be constructed in `buildProgramCodegenView` and used by codegen
for imports, package visibility, and deterministic global effect ids.

### Translate at View Construction Time

`buildProgramCodegenView` becomes the only place that knows how to translate typing stores into boundary DTOs.

All DTO arrays/lists must be sorted deterministically:

- modules sorted by `moduleId`
- per-module lists sorted by local `SymbolId` or name depending on stability requirements

### Enforce the Rule

Add a “boundary hygiene” rule:

- `packages/compiler/src/codegen/*` must not import from `packages/compiler/src/semantics/typing/*`.
- `packages/compiler/src/semantics/codegen-view/*` may import typing internals, but only to perform translation into DTOs.

## Migration Plan (Single PR)

1. Introduce DTO types and translation code.
2. Update codegen to consume DTOs.
3. Remove typing-internal type exports from `ProgramCodegenView`.

## Success Criteria

- Codegen compiles without importing any typing-internal modules.
- Boundary types remain stable when typing internals change.
- All tests pass.
