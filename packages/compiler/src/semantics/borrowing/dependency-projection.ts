import { incrementCompilerPerfCounter } from "../../perf.js";
import { getSymbolTable } from "../_internal/symbol-table.js";
import type { ModuleExportTable } from "../modules.js";
import type { SemanticsPipelineResult } from "../pipeline.js";
import type { BorrowingDependency } from "./dependency.js";
import type { CallableBorrowContract } from "./model.js";

export const projectBorrowingDependencies = (
  dependencies: ReadonlyMap<string, SemanticsPipelineResult> | undefined,
  cache: BorrowingDependencyProjectionCache = defaultBorrowingDependencyProjectionCache,
): ReadonlyMap<string, BorrowingDependency> => {
  const projected = new Map<string, BorrowingDependency>();
  const cachedProjections = Array.from(dependencies ?? []).map(
    ([moduleId, semantics]) =>
      cachedBorrowingDependencyProjection({
        moduleId,
        semantics,
        cache,
        mode: "public",
      }),
  );
  cachedProjections.forEach(({ moduleId, dependency }) => {
    projected.set(
      moduleId,
      mergeBorrowingDependency(projected.get(moduleId), dependency),
    );
  });
  cachedProjections.forEach(({ traitMethods }) => {
    traitMethods.forEach((method) => {
      const moduleId = method.implementation.moduleId;
      const existing = projected.get(moduleId);
      const traitMethodDeclarations = new Map(
        existing?.traitMethodDeclarations,
      );
      const traitMethodContracts = new Map(existing?.traitMethodContracts);
      traitMethodDeclarations.set(
        method.implementation.symbol,
        method.declaration,
      );
      traitMethodContracts.set(method.implementation.symbol, method.contract);
      projected.set(moduleId, {
        callables: existing?.callables ?? new Map(),
        effectOperations: existing?.effectOperations ?? new Map(),
        traitMethodDeclarations,
        traitMethodContracts,
        traitRegionProjections: existing?.traitRegionProjections ?? [],
      });
    });
  });
  return projected;
};

export const selectBorrowingDependencySemantics = ({
  dependencies,
  directDependencyModuleIds,
  importedModuleIds,
}: {
  dependencies: ReadonlyMap<string, SemanticsPipelineResult> | undefined;
  directDependencyModuleIds: Iterable<string>;
  importedModuleIds: Iterable<string>;
}): ReadonlyMap<string, SemanticsPipelineResult> => {
  const selected = new Map<string, SemanticsPipelineResult>();
  const directDependencies = Array.from(directDependencyModuleIds);
  const importedModules = Array.from(importedModuleIds);
  const dependencyIds = new Set([...directDependencies, ...importedModules]);
  incrementCompilerPerfCounter(
    "borrowing.dependencyAssembly.availableModules",
    dependencies?.size ?? 0,
  );
  incrementCompilerPerfCounter(
    "borrowing.dependencyAssembly.directEdges",
    directDependencies.length,
  );
  incrementCompilerPerfCounter(
    "borrowing.dependencyAssembly.importTargets",
    importedModules.length,
  );
  incrementCompilerPerfCounter(
    "borrowing.dependencyAssembly.edgeCandidates",
    dependencyIds.size,
  );
  dependencyIds.forEach((moduleId) => {
    const dependency = dependencies?.get(moduleId);
    if (dependency) {
      selected.set(moduleId, dependency);
    }
  });
  incrementCompilerPerfCounter(
    "borrowing.dependencyAssembly.projectedModules",
    selected.size,
  );
  return selected;
};

export const createBorrowingDependencyProjectionCache =
  (): BorrowingDependencyProjectionCache => ({
    entries: new WeakMap(),
    stats: {
      hits: 0,
      misses: 0,
    },
  });

export const snapshotBorrowingDependencyProjectionCacheStats = (
  cache: BorrowingDependencyProjectionCache,
): Readonly<BorrowingDependencyProjectionCacheStats> => ({ ...cache.stats });

export type BorrowingDependencyProjectionCacheStats = {
  hits: number;
  misses: number;
};

export type BorrowingDependencyProjectionCache = {
  readonly entries: WeakMap<
    SemanticsPipelineResult,
    Map<string, CachedBorrowingDependencyProjection>
  >;
  readonly stats: BorrowingDependencyProjectionCacheStats;
};

type BorrowingDependencyProjectionMode = "public";

type CachedBorrowingDependencyProjection = {
  moduleId: string;
  dependency: BorrowingDependency;
  traitMethods: readonly {
    implementation: NonNullable<
      ModuleExportTable["borrowingTraitImplementations"]
    >[number]["methods"][number]["implementation"];
    declaration: NonNullable<
      ModuleExportTable["borrowingTraitImplementations"]
    >[number]["methods"][number]["declaration"];
    contract: CallableBorrowContract;
  }[];
};

const defaultBorrowingDependencyProjectionCache =
  createBorrowingDependencyProjectionCache();

// Semantic results are immutable snapshots. Object identity prevents
// arena-local signatures and symbols from crossing snapshot boundaries; the
// nested key keeps dependency-module and export/privacy modes isolated.
const cachedBorrowingDependencyProjection = ({
  moduleId,
  semantics,
  cache,
  mode,
}: {
  moduleId: string;
  semantics: SemanticsPipelineResult;
  cache: BorrowingDependencyProjectionCache;
  mode: BorrowingDependencyProjectionMode;
}): CachedBorrowingDependencyProjection => {
  const key = JSON.stringify([mode, moduleId]);
  const cached = cache.entries.get(semantics)?.get(key);
  if (cached) {
    cache.stats.hits += 1;
    incrementCompilerPerfCounter("borrowing.dependencyProjection.cacheHit");
    return cached;
  }

  cache.stats.misses += 1;
  incrementCompilerPerfCounter("borrowing.dependencyProjection.cacheMiss");
  const projection = buildBorrowingDependencyProjection({
    moduleId,
    semantics,
  });
  const entries =
    cache.entries.get(semantics) ??
    new Map<string, CachedBorrowingDependencyProjection>();
  entries.set(key, projection);
  cache.entries.set(semantics, entries);
  return projection;
};

const buildBorrowingDependencyProjection = ({
  moduleId,
  semantics,
}: {
  moduleId: string;
  semantics: SemanticsPipelineResult;
}): CachedBorrowingDependencyProjection => {
  const dependencySymbols = getSymbolTable(semantics);
  const exportedBorrowing = new Map(
    Array.from(semantics.exports.values()).flatMap(
      (entry) =>
        entry.borrowing?.map((borrow) => {
          const summary = {
            dispatch: borrow.dispatch ?? ("ordinary" as const),
            contract: borrow.contract,
            namedContract: borrow.namedContract,
            source: borrow.source,
          };
          return [
            borrow.symbol,
            {
              contract: summary.contract,
              dispatch: summary.dispatch,
              namedContract: summary.namedContract,
              source: summary.source,
            },
          ] as const;
        }) ?? [],
    ),
  );
  const effectSymbols = new Set(
    Array.from(semantics.exports.values()).flatMap(
      (entry) => entry.effects?.map((effect) => effect.symbol) ?? [],
    ),
  );
  const callableSymbols = new Set([
    ...exportedBorrowing.keys(),
    ...effectSymbols,
  ]);
  const callables = new Map(
    Array.from(callableSymbols, (symbol) => [
      symbol,
      {
        name: dependencySymbols.getSymbol(symbol).name,
        signature: semantics.typing.functions.getSignature(symbol),
        contract: exportedBorrowing.get(symbol)?.contract,
        dispatch: exportedBorrowing.get(symbol)?.dispatch,
        namedContract: exportedBorrowing.get(symbol)?.namedContract,
        source: exportedBorrowing.get(symbol)?.source,
      },
    ]),
  );
  const effectOperations = new Map(
    Array.from(effectSymbols).flatMap((symbol) => {
      const operation = semantics.binding.decls.getEffectOperation(symbol);
      return operation
        ? [
            [
              symbol,
              {
                maySuspend: operation.operation.resumable === "resume",
              },
            ] as const,
          ]
        : [];
    }),
  );
  const traitRegionProjections = Array.from(
    new Map(
      Array.from(semantics.exports.values())
        .flatMap((entry) => entry.borrowingCoercions ?? [])
        .flatMap((coercion) => {
          return (
            coercion.contract.parameters[0]?.returnedOrigins?.flatMap(
              (origin) => {
                const result = origin.result[0];
                return result?.kind === "region"
                  ? [
                      {
                        concrete: coercion.concrete,
                        trait: coercion.trait,
                        implementation: coercion.implementation,
                        source: origin.source,
                        result,
                      },
                    ]
                  : [];
              },
            ) ?? []
          );
        })
        .map((projection) => [JSON.stringify(projection), projection] as const),
    ).values(),
  );
  const traitMethods = (
    semantics.exports.borrowingTraitImplementations ?? []
  ).flatMap((implementation) =>
    implementation.methods.map((method) => ({
      implementation: method.implementation,
      declaration: method.declaration,
      contract: method.contract,
    })),
  );
  return {
    moduleId,
    dependency: {
      callables,
      effectOperations,
      traitMethodDeclarations: new Map(),
      traitMethodContracts: new Map(),
      traitRegionProjections,
    },
    traitMethods,
  };
};

const mergeBorrowingDependency = (
  existing: BorrowingDependency | undefined,
  contribution: BorrowingDependency,
): BorrowingDependency => {
  if (!existing) {
    return contribution;
  }
  return {
    callables: new Map([...existing.callables, ...contribution.callables]),
    effectOperations: new Map([
      ...existing.effectOperations,
      ...contribution.effectOperations,
    ]),
    traitMethodDeclarations: new Map([
      ...existing.traitMethodDeclarations,
      ...contribution.traitMethodDeclarations,
    ]),
    traitMethodContracts: new Map([
      ...existing.traitMethodContracts,
      ...contribution.traitMethodContracts,
    ]),
    traitRegionProjections: [
      ...existing.traitRegionProjections,
      ...contribution.traitRegionProjections,
    ],
  };
};
