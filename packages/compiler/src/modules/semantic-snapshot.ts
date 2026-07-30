import {
  createEffectInterner,
  createEffectTable,
  type EffectInterner,
} from "../semantics/effects/effect-table.js";
import type {
  EffectInternerSnapshot,
  EffectTableSnapshot,
} from "../semantics/effects/effect-table.js";
import { SymbolTable } from "../semantics/binder/index.js";
import type { SymbolTableSnapshot } from "../semantics/binder/types.js";
import { DeclTable, type DeclTableSnapshot } from "../semantics/decls.js";
import { getSymbolTable } from "../semantics/_internal/symbol-table.js";
import { cloneNestedMap } from "../semantics/typing/call-resolution.js";
import type { SemanticsPipelineResult } from "../semantics/pipeline.js";
import {
  createTypeArena,
  type TypeArena,
  type TypeArenaSnapshot,
} from "../semantics/typing/type-arena.js";
import { cloneModuleExportTable } from "../semantics/modules.js";
import { buildModuleSymbolIndex } from "../semantics/symbol-index.js";
import {
  FunctionStore,
  ObjectStore,
  TraitStore,
  TypeAliasStore,
  type FunctionStoreSnapshot,
  type ObjectStoreSnapshot,
  type TraitStoreSnapshot,
  type TypeAliasStoreSnapshot,
  type TypingResult,
} from "../semantics/typing/types.js";
import {
  createTypeTable,
  type TypeTableSnapshot,
} from "../semantics/typing/type-table.js";
import type {
  BindingResult,
  BoundOverloadSet,
} from "../semantics/binding/types.js";

export type PersistentBindingSnapshot = Omit<
  BindingResult,
  | "symbolTable"
  | "decls"
  | "functions"
  | "moduleLets"
  | "typeAliases"
  | "objects"
  | "traits"
  | "impls"
  | "effects"
  | "overloads"
  | "dependencies"
> & {
  symbolTable: SymbolTableSnapshot;
  decls: DeclTableSnapshot;
  overloads: readonly [
    number,
    {
      id: number;
      name: string;
      scope: number;
      functionSymbols: readonly number[];
    },
  ][];
  dependencyModuleIds: readonly string[];
};

export type PersistentTypingSnapshot = Omit<
  TypingResult,
  | "arena"
  | "table"
  | "functions"
  | "objects"
  | "traits"
  | "typeAliases"
  | "effects"
> & {
  table: TypeTableSnapshot;
  functions: FunctionStoreSnapshot;
  objects: ObjectStoreSnapshot;
  traits: TraitStoreSnapshot;
  typeAliases: TypeAliasStoreSnapshot;
  effects: EffectTableSnapshot;
};

export type PersistentSemanticsSnapshot = Omit<
  SemanticsPipelineResult,
  "binding" | "symbols" | "typing"
> & {
  binding: PersistentBindingSnapshot;
  typing: PersistentTypingSnapshot;
};

export type PersistentSemanticsMapSnapshot = {
  semantics: readonly (readonly [string, PersistentSemanticsSnapshot])[];
  arena: TypeArenaSnapshot;
  effectInterner: EffectInternerSnapshot;
};

export const snapshotSemanticsMapForPersistence = ({
  semantics,
  arena,
  effectInterner,
}: {
  semantics: ReadonlyMap<string, SemanticsPipelineResult>;
  arena: TypeArenaSnapshot;
  effectInterner: EffectInternerSnapshot;
}): PersistentSemanticsMapSnapshot => ({
  semantics: Array.from(semantics, ([moduleId, entry]) => [
    moduleId,
    snapshotSemanticsForPersistence(entry),
  ]),
  arena,
  effectInterner,
});

export const restoreSemanticsMapFromPersistence = ({
  snapshot,
}: {
  snapshot: PersistentSemanticsMapSnapshot;
}): {
  semantics: ReadonlyMap<string, SemanticsPipelineResult>;
  arena: TypeArena;
  effectInterner: EffectInterner;
} => {
  const arena = createTypeArena(snapshot.arena);
  const effectInterner = createEffectInterner(snapshot.effectInterner);
  const restoredByModuleId = new Map<
    string,
    {
      semantics: SemanticsPipelineResult;
      dependencyModuleIds: readonly string[];
    }
  >();

  snapshot.semantics.forEach(([moduleId, entry]) => {
    restoredByModuleId.set(moduleId, {
      semantics: restoreSemanticsFromPersistence({
        snapshot: entry,
        arena,
        effectInterner,
      }),
      dependencyModuleIds: entry.binding.dependencyModuleIds,
    });
  });
  restoredByModuleId.forEach(({ semantics, dependencyModuleIds }) => {
    semantics.binding.dependencies = new Map(
      dependencyModuleIds.flatMap((dependencyModuleId) => {
        const dependency = restoredByModuleId.get(dependencyModuleId);
        return dependency
          ? [[dependencyModuleId, dependency.semantics.binding] as const]
          : [];
      }),
    );
  });

  return {
    semantics: new Map(
      Array.from(restoredByModuleId, ([moduleId, entry]) => [
        moduleId,
        entry.semantics,
      ]),
    ),
    arena,
    effectInterner,
  };
};

export const cloneSemanticsForTypingState = ({
  semantics,
  arena,
  effectInterner,
}: {
  semantics: SemanticsPipelineResult;
  arena: TypeArena;
  effectInterner: EffectInterner;
}): SemanticsPipelineResult => {
  const symbolTable = getSymbolTable(semantics);
  const typing = semantics.typing;

  return {
    binding: semantics.binding,
    symbols: semantics.symbols,
    hir: semantics.hir,
    borrowing: {
      callables: new Map(semantics.borrowing.callables),
      namedContracts: new Map(semantics.borrowing.namedContracts),
      runtimeIdentityGuards: new Map(semantics.borrowing.runtimeIdentityGuards),
      mutableStorageSymbols: new Set(semantics.borrowing.mutableStorageSymbols),
      diagnostics: [...semantics.borrowing.diagnostics],
    },
    typing: {
      arena,
      table: typing.table.clone(),
      functions: typing.functions.clone(),
      typeAliases: typing.typeAliases.clone(),
      objects: typing.objects.clone(),
      traits: typing.traits.clone(),
      typeParameterConstraints: new Map(typing.typeParameterConstraints),
      primitives: {
        cache: new Map(typing.primitives.cache),
        bool: typing.primitives.bool,
        void: typing.primitives.void,
        unknown: typing.primitives.unknown,
        defaultEffectRow: typing.primitives.defaultEffectRow,
        i32: typing.primitives.i32,
        i64: typing.primitives.i64,
        f32: typing.primitives.f32,
        f64: typing.primitives.f64,
      },
      effects: createEffectTable({
        interner: effectInterner,
        snapshot: typing.effects.snapshotTable(),
      }),
      intrinsicTypes: new Map(typing.intrinsicTypes),
      resolvedExprTypes: new Map(typing.resolvedExprTypes),
      valueTypes: new Map(typing.valueTypes),
      tailResumptions: new Map(typing.tailResumptions),
      objectsByNominal: new Map(typing.objectsByNominal),
      callTargets: cloneNestedMap(typing.callTargets),
      callArgumentPlans: cloneNestedMap(typing.callArgumentPlans),
      functionInstances: new Map(typing.functionInstances),
      callTypeArguments: cloneNestedMap(typing.callTypeArguments),
      callInstanceKeys: cloneNestedMap(typing.callInstanceKeys),
      callTraitDispatches: new Set(typing.callTraitDispatches),
      borrowCallTargets: cloneNestedMap(typing.borrowCallTargets),
      borrowCallArgumentPlans: cloneNestedMap(typing.borrowCallArgumentPlans),
      borrowResolvedExprTypes: new Map(typing.borrowResolvedExprTypes),
      sourceImportLocals: new Set(typing.sourceImportLocals),
      functionInstantiationInfo: cloneNestedMap(
        typing.functionInstantiationInfo,
      ),
      functionInstanceExprTypes: cloneNestedMap(
        typing.functionInstanceExprTypes,
      ),
      functionInstanceValueTypes: cloneNestedMap(
        typing.functionInstanceValueTypes,
      ),
      traitImplsByNominal: new Map(
        Array.from(typing.traitImplsByNominal.entries()).map(
          ([nominal, impls]) => [nominal, [...impls]],
        ),
      ),
      traitImplsByTrait: new Map(
        Array.from(typing.traitImplsByTrait.entries()).map(
          ([symbol, impls]) => [symbol, [...impls]],
        ),
      ),
      traitMethodImpls: new Map(typing.traitMethodImpls),
      memberMetadata: new Map(
        Array.from(typing.memberMetadata.entries()).map(
          ([symbol, metadata]) => [symbol, { ...metadata }],
        ),
      ),
      diagnostics: [...typing.diagnostics],
    },
    moduleId: semantics.moduleId,
    exports: cloneModuleExportTable(semantics.exports),
    diagnostics: [...semantics.diagnostics],
    ...({ symbolTable } as unknown as {}),
  } as SemanticsPipelineResult;
};

export const cloneSemanticsMapForTypingState = ({
  semantics,
  arena,
  effectInterner,
}: {
  semantics: ReadonlyMap<string, SemanticsPipelineResult>;
  arena: TypeArena;
  effectInterner: EffectInterner;
}): Map<string, SemanticsPipelineResult> =>
  new Map(
    Array.from(semantics.entries()).map(([moduleId, entry]) => [
      moduleId,
      cloneSemanticsForTypingState({
        semantics: entry,
        arena,
        effectInterner,
      }),
    ]),
  );

const snapshotSemanticsForPersistence = (
  semantics: SemanticsPipelineResult,
): PersistentSemanticsSnapshot => {
  const binding = semantics.binding;
  const typing = semantics.typing;
  return {
    moduleId: semantics.moduleId,
    hir: semantics.hir,
    borrowing: semantics.borrowing,
    exports: semantics.exports,
    diagnostics: semantics.diagnostics,
    binding: {
      scopeByNode: binding.scopeByNode,
      decls: binding.decls.snapshot(),
      overloadBySymbol: binding.overloadBySymbol,
      diagnostics: binding.diagnostics,
      uses: binding.uses,
      imports: binding.imports,
      staticMethods: binding.staticMethods,
      moduleMembers: binding.moduleMembers,
      importedOverloadOptions: binding.importedOverloadOptions,
      modulePath: binding.modulePath,
      packageId: binding.packageId,
      isPackageRoot: binding.isPackageRoot,
      symbolTable: getSymbolTable(semantics).snapshot(),
      overloads: Array.from(binding.overloads, ([id, overload]) => [
        id,
        {
          id: overload.id,
          name: overload.name,
          scope: overload.scope,
          functionSymbols: overload.functions.map((fn) => fn.symbol),
        },
      ]),
      dependencyModuleIds: Array.from(binding.dependencies.keys()),
    },
    typing: {
      table: typing.table.snapshot(),
      functions: typing.functions.snapshot(),
      typeAliases: typing.typeAliases.snapshot(),
      objects: typing.objects.snapshot(),
      traits: typing.traits.snapshot(),
      typeParameterConstraints: typing.typeParameterConstraints,
      primitives: typing.primitives,
      effects: typing.effects.snapshotTable(),
      intrinsicTypes: typing.intrinsicTypes,
      resolvedExprTypes: typing.resolvedExprTypes,
      valueTypes: typing.valueTypes,
      tailResumptions: typing.tailResumptions,
      objectsByNominal: typing.objectsByNominal,
      callTargets: typing.callTargets,
      callArgumentPlans: typing.callArgumentPlans,
      functionInstances: typing.functionInstances,
      callTypeArguments: typing.callTypeArguments,
      callInstanceKeys: typing.callInstanceKeys,
      callTraitDispatches: typing.callTraitDispatches,
      borrowCallTargets: typing.borrowCallTargets,
      borrowCallArgumentPlans: typing.borrowCallArgumentPlans,
      borrowResolvedExprTypes: typing.borrowResolvedExprTypes,
      sourceImportLocals: typing.sourceImportLocals,
      functionInstantiationInfo: typing.functionInstantiationInfo,
      functionInstanceExprTypes: typing.functionInstanceExprTypes,
      functionInstanceValueTypes: typing.functionInstanceValueTypes,
      traitImplsByNominal: typing.traitImplsByNominal,
      traitImplsByTrait: typing.traitImplsByTrait,
      traitMethodImpls: typing.traitMethodImpls,
      memberMetadata: typing.memberMetadata,
      diagnostics: typing.diagnostics,
    },
  };
};

const restoreSemanticsFromPersistence = ({
  snapshot,
  arena,
  effectInterner,
}: {
  snapshot: PersistentSemanticsSnapshot;
  arena: TypeArena;
  effectInterner: EffectInterner;
}): SemanticsPipelineResult => {
  const symbolTable = new SymbolTable({ rootOwner: 0 });
  symbolTable.restore(snapshot.binding.symbolTable);
  const decls = DeclTable.fromSnapshot(snapshot.binding.decls);
  const overloads = new Map<number, BoundOverloadSet>(
    snapshot.binding.overloads.map(([id, overload]) => [
      id,
      {
        id: overload.id,
        name: overload.name,
        scope: overload.scope,
        functions: overload.functionSymbols.flatMap((symbol) => {
          const fn = decls.getFunction(symbol);
          return fn ? [fn] : [];
        }),
      },
    ]),
  );
  const binding: BindingResult = {
    scopeByNode: snapshot.binding.scopeByNode,
    decls,
    functions: decls.functions,
    moduleLets: decls.moduleLets,
    typeAliases: decls.typeAliases,
    objects: decls.objects,
    traits: decls.traits,
    impls: decls.impls,
    effects: decls.effects,
    overloads,
    overloadBySymbol: snapshot.binding.overloadBySymbol,
    diagnostics: snapshot.binding.diagnostics,
    uses: snapshot.binding.uses,
    imports: snapshot.binding.imports,
    staticMethods: snapshot.binding.staticMethods,
    moduleMembers: snapshot.binding.moduleMembers,
    dependencies: new Map(),
    importedOverloadOptions: snapshot.binding.importedOverloadOptions,
    modulePath: snapshot.binding.modulePath,
    packageId: snapshot.binding.packageId,
    isPackageRoot: snapshot.binding.isPackageRoot,
    symbolTable,
  };
  const typing: TypingResult = {
    arena,
    table: createTypeTable(snapshot.typing.table),
    functions: FunctionStore.fromSnapshot(snapshot.typing.functions),
    typeAliases: TypeAliasStore.fromSnapshot(snapshot.typing.typeAliases),
    objects: ObjectStore.fromSnapshot(snapshot.typing.objects),
    traits: TraitStore.fromSnapshot(snapshot.typing.traits),
    typeParameterConstraints: snapshot.typing.typeParameterConstraints,
    primitives: snapshot.typing.primitives,
    effects: createEffectTable({
      interner: effectInterner,
      snapshot: snapshot.typing.effects,
    }),
    intrinsicTypes: snapshot.typing.intrinsicTypes,
    resolvedExprTypes: snapshot.typing.resolvedExprTypes,
    valueTypes: snapshot.typing.valueTypes,
    tailResumptions: snapshot.typing.tailResumptions,
    objectsByNominal: snapshot.typing.objectsByNominal,
    callTargets: snapshot.typing.callTargets,
    callArgumentPlans: snapshot.typing.callArgumentPlans,
    functionInstances: snapshot.typing.functionInstances,
    callTypeArguments: snapshot.typing.callTypeArguments,
    callInstanceKeys: snapshot.typing.callInstanceKeys,
    callTraitDispatches: snapshot.typing.callTraitDispatches,
    borrowCallTargets: snapshot.typing.borrowCallTargets,
    borrowCallArgumentPlans: snapshot.typing.borrowCallArgumentPlans,
    borrowResolvedExprTypes: snapshot.typing.borrowResolvedExprTypes,
    sourceImportLocals: snapshot.typing.sourceImportLocals,
    functionInstantiationInfo: snapshot.typing.functionInstantiationInfo,
    functionInstanceExprTypes: snapshot.typing.functionInstanceExprTypes,
    functionInstanceValueTypes: snapshot.typing.functionInstanceValueTypes,
    traitImplsByNominal: snapshot.typing.traitImplsByNominal,
    traitImplsByTrait: snapshot.typing.traitImplsByTrait,
    traitMethodImpls: snapshot.typing.traitMethodImpls,
    memberMetadata: snapshot.typing.memberMetadata,
    diagnostics: snapshot.typing.diagnostics,
  };
  return {
    binding,
    hir: snapshot.hir,
    typing,
    borrowing: snapshot.borrowing,
    moduleId: snapshot.moduleId,
    exports: snapshot.exports,
    diagnostics: snapshot.diagnostics,
    symbols: buildModuleSymbolIndex({
      moduleId: snapshot.moduleId,
      packageId: binding.packageId,
      symbolTable,
    }),
    symbolTable,
  } as SemanticsPipelineResult;
};
