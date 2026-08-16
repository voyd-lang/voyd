import {
  createEffectInterner,
  createEffectTable,
  type EffectInterner,
  type EffectInternerSnapshot,
} from "../semantics/effects/effect-table.js";
import type { SemanticsPipelineResult } from "../semantics/pipeline.js";
import {
  createTypeArena,
  type TypeArena,
  type TypeArenaSnapshot,
} from "../semantics/typing/type-arena.js";
import { cloneModuleExportTable } from "../semantics/modules.js";
import { SymbolTable } from "../semantics/binder/index.js";
import {
  DeclTable,
  type EffectDecl,
  type FunctionDecl,
  type ImplDecl,
  type ObjectDecl,
  type TraitDecl,
} from "../semantics/decls.js";
import type {
  BindingResult,
  BoundImport,
} from "../semantics/binding/binding.js";
import type { HirGraph, HirItem } from "../semantics/hir/index.js";
import { buildModuleSymbolIndex } from "../semantics/symbol-index.js";
import type {
  CallArgumentPlanEntry,
  FunctionSignature,
  TraitImplInstance,
  TypeAliasTemplate,
  TypingResult,
} from "../semantics/typing/types.js";

/**
 * An in-memory cold dependency commit. The canonical semantic graph is kept in
 * this module's closure and can only be consumed by restoring a fresh working
 * graph. This keeps source analysis from acquiring a reference to canonical
 * cache state.
 */
export type ReusableDependencySemanticsSnapshot = Readonly<{
  moduleIds: readonly string[];
  restore(): {
    semantics: Map<string, SemanticsPipelineResult>;
    typingState: { arena: TypeArena; effectInterner: EffectInterner };
  };
}>;

export const createReusableDependencySemanticsSnapshot = ({
  moduleIds,
  semantics,
  arena,
  effectInterner,
}: {
  moduleIds: readonly string[];
  semantics: ReadonlyMap<string, SemanticsPipelineResult>;
  arena: TypeArenaSnapshot;
  effectInterner: EffectInternerSnapshot;
}): ReusableDependencySemanticsSnapshot => {
  const canonicalArena = createTypeArena(arena);
  const canonicalEffectInterner = createEffectInterner(effectInterner);
  const canonicalSemantics = cloneSemanticsMapForTypingState({
    semantics,
    arena: canonicalArena,
    effectInterner: canonicalEffectInterner,
  });
  const canonicalArenaSnapshot = canonicalArena.snapshot();
  const canonicalEffectSnapshot = canonicalEffectInterner.snapshotInterner();

  return Object.freeze({
    moduleIds: Object.freeze([...moduleIds]),
    restore: () => {
      const restoredArena = createTypeArena(canonicalArenaSnapshot);
      const restoredEffectInterner = createEffectInterner(
        canonicalEffectSnapshot,
      );
      return {
        semantics: cloneSemanticsMapForTypingState({
          semantics: canonicalSemantics,
          arena: restoredArena,
          effectInterner: restoredEffectInterner,
        }),
        typingState: {
          arena: restoredArena,
          effectInterner: restoredEffectInterner,
        },
      };
    },
  });
};

export const cloneSemanticsMapForTypingState = ({
  semantics,
  arena,
  effectInterner,
}: {
  semantics: ReadonlyMap<string, SemanticsPipelineResult>;
  arena: TypeArena;
  effectInterner: EffectInterner;
}): Map<string, SemanticsPipelineResult> => {
  const clones = new Map<string, SemanticsPipelineResult>();

  semantics.forEach((entry, moduleId) => {
    const hir = clonePlainData(entry.hir);
    const binding = cloneBindingResult(entry.binding);
    const symbolTable = binding.symbolTable;
    const typing = cloneTypingResult({
      typing: entry.typing,
      arena,
      effectInterner,
      hir,
    });
    const clone = {
      binding,
      symbols: buildModuleSymbolIndex({
        moduleId: entry.moduleId,
        packageId: binding.packageId,
        symbolTable,
      }),
      hir,
      borrowing: clonePlainData(entry.borrowing),
      typing,
      moduleId: entry.moduleId,
      exports: cloneModuleExportTable(entry.exports),
      diagnostics: clonePlainData(entry.diagnostics),
      ...({ symbolTable } as unknown as {}),
    } as SemanticsPipelineResult;
    clones.set(moduleId, clone);
  });

  semantics.forEach((entry, moduleId) => {
    const clonedBinding = clones.get(moduleId)!.binding;
    clonedBinding.dependencies = new Map(
      Array.from(entry.binding.dependencies, ([dependencyId]) => {
        const dependency = clones.get(dependencyId)?.binding;
        if (!dependency) {
          throw new Error(
            `dependency snapshot for ${moduleId} is missing ${dependencyId}`,
          );
        }
        return [dependencyId, dependency];
      }),
    );
  });

  return clones;
};

const cloneBindingResult = (binding: BindingResult): BindingResult => {
  const symbolTable = cloneSymbolTable(getSymbolTableFromBinding(binding));
  const decls = cloneDeclTable(binding.decls);
  const importClones = new Map<BoundImport, BoundImport>();
  const cloneImport = (entry: BoundImport): BoundImport => {
    const cached = importClones.get(entry);
    if (cached) {
      return cached;
    }
    const cloned = clonePlainData(entry);
    importClones.set(entry, cloned);
    return cloned;
  };
  const imports = binding.imports.map(cloneImport);

  return {
    symbolTable,
    scopeByNode: new Map(binding.scopeByNode),
    decls,
    functions: decls.functions,
    moduleLets: decls.moduleLets,
    typeAliases: decls.typeAliases,
    objects: decls.objects,
    traits: decls.traits,
    impls: decls.impls,
    effects: decls.effects,
    overloads: new Map(
      Array.from(binding.overloads, ([id, overload]) => [
        id,
        {
          ...overload,
          functions: overload.functions.map(
            (fn) => decls.getFunction(fn.symbol) ?? clonePlainData(fn),
          ),
        },
      ]),
    ),
    overloadBySymbol: new Map(binding.overloadBySymbol),
    diagnostics: clonePlainData(binding.diagnostics),
    uses: binding.uses.map((use) => ({
      ...use,
      visibility: { ...use.visibility },
      entries: use.entries.map((entry) => ({
        ...entry,
        path: [...entry.path],
        span: { ...entry.span },
        imports: entry.imports.map(cloneImport),
      })),
    })),
    imports,
    staticMethods: cloneSymbolMemberTable(binding.staticMethods),
    moduleMembers: cloneSymbolMemberTable(binding.moduleMembers),
    dependencies: new Map(),
    importedOverloadOptions: new Map(
      Array.from(binding.importedOverloadOptions, ([id, symbols]) => [
        id,
        [...symbols],
      ]),
    ),
    directSymbolBySyntax: new Map(binding.directSymbolBySyntax),
    modulePath: clonePlainData(binding.modulePath),
    packageId: binding.packageId,
    isPackageRoot: binding.isPackageRoot,
  };
};

const cloneTypingResult = ({
  typing,
  arena,
  effectInterner,
  hir,
}: {
  typing: TypingResult;
  arena: TypeArena;
  effectInterner: EffectInterner;
  hir: HirGraph;
}): TypingResult => {
  const hirItemsBySymbol = new Map(
    Array.from(hir.items.values())
      .filter((item): item is HirItem & { symbol: number } => "symbol" in item)
      .map((item) => [item.symbol, item]),
  );
  const hirCallablesBySymbol = collectHirCallables(hir);
  const traitImplClones = new Map<TraitImplInstance, TraitImplInstance>();
  const cloneTraitImpl = (
    implementation: TraitImplInstance,
  ): TraitImplInstance => {
    const cached = traitImplClones.get(implementation);
    if (cached) {
      return cached;
    }
    const clone = {
      ...implementation,
      methods: new Map(implementation.methods),
      staticMethods: new Map(implementation.staticMethods),
    };
    traitImplClones.set(implementation, clone);
    return clone;
  };
  const functions = typing.functions.clone({
    resolveFunction: (symbol) => {
      const item = hirItemsBySymbol.get(symbol);
      return item?.kind === "function" ? item : undefined;
    },
    cloneSignature: (symbol, signature) =>
      cloneFunctionSignatureForHir({
        signature,
        callable: hirCallablesBySymbol.get(symbol),
      }),
  });
  const objects = typing.objects.clone({
    resolveDecl: (symbol) => {
      const item = hirItemsBySymbol.get(symbol);
      return item?.kind === "object" ? item : undefined;
    },
    cloneTraitImpl,
  });
  const traits = typing.traits.clone({
    resolveDecl: (symbol) => {
      const item = hirItemsBySymbol.get(symbol);
      return item?.kind === "trait" ? item : undefined;
    },
  });
  const typeAliases = typing.typeAliases.clone({
    resolveTemplate: (symbol) => {
      const item = hirItemsBySymbol.get(symbol);
      if (item?.kind !== "type-alias") {
        return undefined;
      }
      return {
        symbol,
        params:
          item.typeParameters?.map((parameter) => ({
            symbol: parameter.symbol,
            constraint: parameter.constraint,
          })) ?? [],
        target: item.target,
      } satisfies TypeAliasTemplate;
    },
  });

  return {
    arena,
    table: typing.table.clone(),
    functions,
    typeAliases,
    objects,
    traits,
    typeParameterConstraints: new Map(typing.typeParameterConstraints),
    primitives: {
      ...typing.primitives,
      cache: new Map(typing.primitives.cache),
    },
    effects: createEffectTable({
      interner: effectInterner,
      snapshot: typing.effects.snapshotTable(),
    }),
    intrinsicTypes: new Map(typing.intrinsicTypes),
    resolvedExprTypes: new Map(typing.resolvedExprTypes),
    valueTypes: new Map(typing.valueTypes),
    tailResumptions: new Map(
      Array.from(typing.tailResumptions, ([expr, resumption]) => [
        expr,
        clonePlainData(resumption),
      ]),
    ),
    objectsByNominal: objects.snapshotByNominal(),
    callTargets: cloneNestedMapValues(typing.callTargets, clonePlainData),
    callArgumentPlans: cloneNestedMapValues(
      typing.callArgumentPlans,
      cloneCallArgumentPlan,
    ),
    functionInstances: functions.snapshotInstances(),
    callTypeArguments: cloneNestedMapValues(
      typing.callTypeArguments,
      (types) => [...types],
    ),
    callInstanceKeys: cloneNestedMapValues(
      typing.callInstanceKeys,
      (key) => key,
    ),
    callTraitDispatches: new Set(typing.callTraitDispatches),
    borrowCallTargets: cloneNestedMapValues(
      typing.borrowCallTargets,
      clonePlainData,
    ),
    borrowCallArgumentPlans: cloneNestedMapValues(
      typing.borrowCallArgumentPlans,
      cloneCallArgumentPlan,
    ),
    borrowResolvedExprTypes: new Map(typing.borrowResolvedExprTypes),
    sourceImportLocals: new Set(typing.sourceImportLocals),
    functionInstantiationInfo: functions.snapshotInstantiationInfo(),
    functionInstanceExprTypes: functions.snapshotInstanceExprTypes(),
    functionInstanceValueTypes: functions.snapshotInstanceValueTypes(),
    traitImplsByNominal: cloneTraitImplIndex(
      typing.traitImplsByNominal,
      cloneTraitImpl,
    ),
    traitImplsByTrait: cloneTraitImplIndex(
      typing.traitImplsByTrait,
      cloneTraitImpl,
    ),
    traitMethodImpls: new Map(
      Array.from(typing.traitMethodImpls, ([symbol, impl]) => [
        symbol,
        { ...impl },
      ]),
    ),
    memberMetadata: new Map(
      Array.from(typing.memberMetadata, ([symbol, metadata]) => [
        symbol,
        { ...metadata },
      ]),
    ),
    diagnostics: clonePlainData(typing.diagnostics),
  };
};

type RestoredHirCallable = {
  parameters: readonly {
    symbol: number;
    type?: FunctionSignature["parameters"][number]["declaredType"];
    span: NonNullable<FunctionSignature["parameters"][number]["span"]>;
  }[];
  returnType?: FunctionSignature["declaredReturnType"];
  resultIdentity?: FunctionSignature["resultIdentity"];
  stagedAccess?: FunctionSignature["stagedAccess"];
  builderAccess?: FunctionSignature["builderAccess"];
};

const collectHirCallables = (
  hir: HirGraph,
): Map<number, RestoredHirCallable> => {
  const callables = new Map<number, RestoredHirCallable>();
  hir.items.forEach((item) => {
    if (item.kind === "function") {
      callables.set(item.symbol, item);
      return;
    }
    if (item.kind === "trait") {
      item.methods.forEach((method) => callables.set(method.symbol, method));
      return;
    }
    if (item.kind === "effect") {
      item.operations.forEach((operation) =>
        callables.set(operation.symbol, operation),
      );
    }
  });
  return callables;
};

const cloneFunctionSignatureForHir = ({
  signature,
  callable,
}: {
  signature: FunctionSignature;
  callable: RestoredHirCallable | undefined;
}): FunctionSignature => {
  const clone = clonePlainData(signature);
  if (!callable) {
    return clone;
  }

  return {
    ...clone,
    parameters: clone.parameters.map((parameter, index) => {
      const hirParameter =
        (typeof parameter.symbol === "number"
          ? callable.parameters.find(
              (candidate) => candidate.symbol === parameter.symbol,
            )
          : undefined) ?? callable.parameters[index];
      return {
        ...parameter,
        declaredType: hirParameter?.type ?? parameter.declaredType,
        span: hirParameter?.span ?? parameter.span,
      };
    }),
    declaredReturnType: callable.returnType,
    resultIdentity: callable.resultIdentity ?? clone.resultIdentity,
    stagedAccess: callable.stagedAccess ?? clone.stagedAccess,
    builderAccess: callable.builderAccess ?? clone.builderAccess,
  };
};

const cloneCallArgumentPlan = (
  plan: readonly CallArgumentPlanEntry[],
): readonly CallArgumentPlanEntry[] => plan.map((entry) => ({ ...entry }));

const cloneTraitImplIndex = <K>(
  source: ReadonlyMap<K, readonly TraitImplInstance[]>,
  cloneTraitImpl: (implementation: TraitImplInstance) => TraitImplInstance,
): Map<K, readonly TraitImplInstance[]> =>
  new Map(
    Array.from(source, ([key, implementations]) => [
      key,
      implementations.map(cloneTraitImpl),
    ]),
  );

const cloneNestedMapValues = <K, NK, V, C>(
  source: ReadonlyMap<K, ReadonlyMap<NK, V>>,
  cloneValue: (value: V) => C,
): Map<K, Map<NK, C>> =>
  new Map(
    Array.from(source, ([key, inner]) => [
      key,
      new Map(
        Array.from(inner, ([innerKey, value]) => [innerKey, cloneValue(value)]),
      ),
    ]),
  );

const cloneSymbolMemberTable = (
  source: ReadonlyMap<number, ReadonlyMap<string, ReadonlySet<number>>>,
): Map<number, Map<string, Set<number>>> =>
  new Map(
    Array.from(source, ([symbol, members]) => [
      symbol,
      new Map(
        Array.from(members, ([name, symbols]) => [name, new Set(symbols)]),
      ),
    ]),
  );

const cloneDeclTable = (source: DeclTable): DeclTable => {
  const clone = new DeclTable();
  source.functions.forEach((fn) => clone.registerFunction(cloneFunction(fn)));
  source.moduleLets.forEach((decl) =>
    clone.registerModuleLet(clonePlainData(decl)),
  );
  source.typeAliases.forEach((decl) =>
    clone.registerTypeAlias(clonePlainData(decl)),
  );
  source.objects.forEach((decl) => clone.registerObject(cloneObject(decl)));
  source.traits.forEach((decl) => clone.registerTrait(cloneTrait(decl)));
  source.impls.forEach((decl) => clone.registerImpl(cloneImpl(decl, clone)));
  source.effects.forEach((decl) => clone.registerEffect(cloneEffect(decl)));
  return clone;
};

const cloneFunction = (fn: FunctionDecl): FunctionDecl => ({
  ...fn,
  visibility: { ...fn.visibility },
  params: fn.params.map((parameter) => ({ ...parameter })),
  typeParameters: fn.typeParameters?.map((parameter) => ({ ...parameter })),
  resultIdentity: clonePlainData(fn.resultIdentity),
  stagedAccess: clonePlainData(fn.stagedAccess),
  builderAccess: clonePlainData(fn.builderAccess),
  intrinsic: clonePlainData(fn.intrinsic),
});

const cloneObject = (decl: ObjectDecl): ObjectDecl => ({
  ...decl,
  visibility: { ...decl.visibility },
  fields: decl.fields.map((field) => ({
    ...field,
    visibility: { ...field.visibility },
  })),
  typeParameters: decl.typeParameters?.map((parameter) => ({ ...parameter })),
});

const cloneTrait = (decl: TraitDecl): TraitDecl => ({
  ...decl,
  visibility: { ...decl.visibility },
  typeParameters: decl.typeParameters?.map((parameter) => ({ ...parameter })),
  methods: decl.methods.map((method) => ({
    ...method,
    params: method.params.map((parameter) => ({ ...parameter })),
    typeParameters: method.typeParameters?.map((parameter) => ({
      ...parameter,
    })),
    resultIdentity: clonePlainData(method.resultIdentity),
    stagedAccess: clonePlainData(method.stagedAccess),
    builderAccess: clonePlainData(method.builderAccess),
    intrinsic: clonePlainData(method.intrinsic),
  })),
});

const cloneImpl = (decl: ImplDecl, decls: DeclTable): ImplDecl => ({
  ...decl,
  visibility: { ...decl.visibility },
  typeParameters: decl.typeParameters?.map((parameter) => ({ ...parameter })),
  methods: decl.methods.map(
    (method) => decls.getFunction(method.symbol) ?? cloneFunction(method),
  ),
});

const cloneEffect = (decl: EffectDecl): EffectDecl => ({
  ...decl,
  visibility: { ...decl.visibility },
  typeParameters: decl.typeParameters?.map((parameter) => ({ ...parameter })),
  operations: decl.operations.map((operation) => ({
    ...operation,
    parameters: operation.parameters.map((parameter) => ({ ...parameter })),
  })),
});

const getSymbolTableFromBinding = (binding: BindingResult): SymbolTable =>
  binding.symbolTable;

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

const clonePlainData = <T>(value: T, seen = new Map<object, unknown>()): T => {
  if (value === null || typeof value !== "object") {
    return value;
  }
  const cached = seen.get(value);
  if (cached !== undefined) {
    return cached as T;
  }
  if (Array.isArray(value)) {
    const clone: unknown[] = [];
    seen.set(value, clone);
    value.forEach((entry) => clone.push(clonePlainData(entry, seen)));
    return clone as T;
  }
  if (value instanceof Map) {
    const clone = new Map();
    seen.set(value, clone);
    value.forEach((entry, key) => clone.set(key, clonePlainData(entry, seen)));
    return clone as T;
  }
  if (value instanceof Set) {
    const clone = new Set();
    seen.set(value, clone);
    value.forEach((entry) => clone.add(clonePlainData(entry, seen)));
    return clone as T;
  }
  if (value instanceof Uint8Array) {
    return value.slice() as T;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return value;
  }
  const clone: Record<PropertyKey, unknown> = {};
  seen.set(value, clone);
  Reflect.ownKeys(value).forEach((key) => {
    clone[key] = clonePlainData(
      (value as Record<PropertyKey, unknown>)[key],
      seen,
    );
  });
  return clone as T;
};
