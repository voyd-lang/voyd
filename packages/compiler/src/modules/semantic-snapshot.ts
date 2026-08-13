import {
  createEffectTable,
  type EffectInterner,
} from "../semantics/effects/effect-table.js";
import { getSymbolTable } from "../semantics/_internal/symbol-table.js";
import { cloneNestedMap } from "../semantics/typing/call-resolution.js";
import type { SemanticsPipelineResult } from "../semantics/pipeline.js";
import type { TypeArena } from "../semantics/typing/type-arena.js";
import { cloneModuleExportTable } from "../semantics/modules.js";
import { SymbolTable } from "../semantics/binder/index.js";

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
  const clonedSymbolTable = cloneSymbolTable(symbolTable);
  const typing = semantics.typing;

  return {
    binding: { ...semantics.binding, symbolTable: clonedSymbolTable },
    symbols: semantics.symbols,
    hir: semantics.hir,
    borrowing: {
      ordinaryMutationSummaries: new Map(
        semantics.borrowing.ordinaryMutationSummaries,
      ),
      defaultIdentityGuardTargets: new Set(
        semantics.borrowing.defaultIdentityGuardTargets,
      ),
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
    ...({ symbolTable: clonedSymbolTable } as unknown as {}),
  } as SemanticsPipelineResult;
};

const cloneSymbolTable = (source: SymbolTable): SymbolTable => {
  const snapshot = source.snapshot();
  const root = snapshot.scopes.find((scope) => scope.id === source.rootScope);
  if (!root) {
    throw new Error("cannot clone a symbol table without its root scope");
  }
  const clone = new SymbolTable({
    rootOwner: root.owner,
    rootKind: root.kind === "macro" ? "macro" : "module",
  });
  clone.restore(snapshot);
  return clone;
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
