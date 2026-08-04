import { incrementCompilerPerfCounter } from "../../perf.js";
import { getSymbolTable } from "../_internal/symbol-table.js";
import type {
  ModuleExportTable,
  PackageCallableSignature,
  PackageSemanticInterface,
} from "../modules.js";
import type { SemanticsPipelineResult } from "../pipeline.js";
import type { BorrowingDependency } from "./dependency.js";
import type { CallableBorrowContract } from "./model.js";
import {
  PACKAGE_SEMANTIC_INTERFACE_SCHEMA,
  PACKAGE_SEMANTIC_INTERFACE_VERSION,
} from "../modules.js";

/** Durable, symbol-arena-independent dependency view. This is the package
 * interface consumer used by separate compilation and by the in-process
 * SymbolId adapter below. */
export type PackageBorrowingDependency = {
  callables: ReadonlyMap<
    string,
    {
      name: string;
      signature?: PackageCallableSignature;
      capability?: import("./capability.js").LoanAnalysisMode;
      summary?: PackageSemanticInterface["summaries"][number]["summary"];
    }
  >;
  effectOperations: ReadonlyMap<
    string,
    { name: string; maySuspend: boolean; signature?: PackageCallableSignature }
  >;
  coercions: PackageSemanticInterface["coercions"];
  callableResultCoercions: PackageSemanticInterface["callableResultCoercions"];
  traitImplementations: PackageSemanticInterface["traitImplementations"];
};

export const projectPackageSemanticInterface = (
  packageInterface: PackageSemanticInterface,
): PackageBorrowingDependency => {
  if (
    packageInterface.schema !== PACKAGE_SEMANTIC_INTERFACE_SCHEMA ||
    packageInterface.version !== PACKAGE_SEMANTIC_INTERFACE_VERSION
  ) {
    throw new Error(
      `unsupported package semantic interface ${packageInterface.schema}@${packageInterface.version}`,
    );
  }
  const summaries = new Map(
    packageInterface.summaries.map(({ id, summary }) => [id, summary]),
  );
  const callables = new Map<
    string,
    {
      name: string;
      signature?: PackageCallableSignature;
      capability?: import("./capability.js").LoanAnalysisMode;
      summary?: PackageSemanticInterface["summaries"][number]["summary"];
    }
  >();
  const effectOperations = new Map<
    string,
    { name: string; maySuspend: boolean; signature?: PackageCallableSignature }
  >();
  packageInterface.exports.forEach((entry) => {
    entry.declarations.forEach((declaration) => {
      if (!declaration.signature && !declaration.summaryId) return;
      callables.set(declaration.key, {
        name: entry.name,
        ...(declaration.signature ? { signature: declaration.signature } : {}),
        ...(declaration.capability
          ? { capability: declaration.capability }
          : {}),
        ...(declaration.summaryId
          ? { summary: summaries.get(declaration.summaryId) }
          : {}),
      });
    });
    entry.members.forEach((member) => {
      const projected = {
        name: member.name,
        ...(member.signature ? { signature: member.signature } : {}),
        ...(member.capability ? { capability: member.capability } : {}),
        ...(member.summaryId
          ? { summary: summaries.get(member.summaryId) }
          : {}),
      };
      callables.set(member.key, projected);
      if (member.kind === "effect-operation") {
        effectOperations.set(member.key, {
          name: member.name,
          maySuspend: member.resumable === "ctl",
          ...(member.signature ? { signature: member.signature } : {}),
        });
      }
    });
  });
  return {
    callables,
    effectOperations,
    coercions: packageInterface.coercions,
    callableResultCoercions: packageInterface.callableResultCoercions,
    traitImplementations: packageInterface.traitImplementations,
  };
};

export const projectBorrowingDependencies = (
  dependencies: ReadonlyMap<string, SemanticsPipelineResult> | undefined,
  cache: BorrowingDependencyProjectionCache = defaultBorrowingDependencyProjectionCache,
): ReadonlyMap<string, BorrowingDependency> => {
  const projected = new Map<string, BorrowingDependency>();
  const durableSymbols = durableSymbolIndex(dependencies ?? new Map());
  const cachedProjections = Array.from(dependencies ?? []).map(
    ([moduleId, semantics]) =>
      cachedBorrowingDependencyProjection({
        moduleId,
        semantics,
        cache,
        mode: "public",
        durableSymbols,
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
  durableSymbols,
}: {
  moduleId: string;
  semantics: SemanticsPipelineResult;
  cache: BorrowingDependencyProjectionCache;
  mode: BorrowingDependencyProjectionMode;
  durableSymbols: ReadonlyMap<
    string,
    import("../typing/symbol-ref.js").SymbolRef
  >;
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
    durableSymbols,
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
  durableSymbols,
}: {
  moduleId: string;
  semantics: SemanticsPipelineResult;
  durableSymbols: ReadonlyMap<
    string,
    import("../typing/symbol-ref.js").SymbolRef
  >;
}): CachedBorrowingDependencyProjection => {
  const dependencySymbols = getSymbolTable(semantics);
  const packageInterface = semantics.exports.packageSemanticInterface;
  if (!packageInterface) {
    throw new Error(`missing package semantic interface for ${moduleId}`);
  }
  const packageDependency = projectPackageSemanticInterface(packageInterface);
  const summaryIdsToKeys = new Map<string, string>();
  packageInterface.exports.forEach((entry) => {
    [...entry.declarations, ...entry.members].forEach((declaration) => {
      if (declaration.summaryId) {
        summaryIdsToKeys.set(declaration.summaryId, declaration.key);
      }
    });
  });
  const keysBySymbol = new Map<number, string>();
  semantics.exports.forEach((entry) => {
    const stableExport = packageInterface.exports.find(
      (candidate) => candidate.name === entry.name,
    );
    (entry.symbols ?? [entry.symbol]).forEach((symbol, index) => {
      const key = stableExport?.declarations.at(index)?.key;
      if (key) keysBySymbol.set(symbol, key);
    });
    entry.borrowing?.forEach((borrow) => {
      const key = summaryIdsToKeys.get(borrow.summaryId);
      if (key) keysBySymbol.set(borrow.symbol, key);
    });
  });
  const exportedBorrowing = new Map(
    Array.from(semantics.exports.values()).flatMap(
      (entry) =>
        entry.borrowing?.map((borrow) => {
          const key = keysBySymbol.get(borrow.symbol);
          const callable = key
            ? packageDependency.callables.get(key)
            : undefined;
          if (!callable?.summary) {
            throw new Error(
              `package semantic interface ${moduleId} is missing ${borrow.summaryId}`,
            );
          }
          return [
            borrow.symbol,
            {
              capability: callable.capability,
              contract: callable.summary.contract,
              dispatch: callable.summary.dispatch,
              namedContract: callable.summary.namedContract,
              source: callable.summary.source ?? borrow.source,
            },
          ] as const;
        }) ?? [],
    ),
  );
  const effectSymbols = new Set(
    Array.from(keysBySymbol).flatMap(([symbol, key]) =>
      packageDependency.effectOperations.has(key) ? [symbol] : [],
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
        name:
          packageDependency.callables.get(keysBySymbol.get(symbol) ?? "")
            ?.name ?? dependencySymbols.getSymbol(symbol).name,
        signature: semantics.typing.functions.getSignature(symbol),
        contract: exportedBorrowing.get(symbol)?.contract,
        capability: exportedBorrowing.get(symbol)?.capability,
        dispatch: exportedBorrowing.get(symbol)?.dispatch,
        namedContract: exportedBorrowing.get(symbol)?.namedContract,
        source: exportedBorrowing.get(symbol)?.source,
      },
    ]),
  );
  const effectOperations = new Map(
    Array.from(effectSymbols).flatMap((symbol) => {
      const operation = packageDependency.effectOperations.get(
        keysBySymbol.get(symbol) ?? "",
      );
      return operation
        ? [
            [
              symbol,
              {
                maySuspend: operation.maySuspend,
              },
            ] as const,
          ]
        : [];
    }),
  );
  const traitRegionProjections = Array.from(
    new Map(
      packageDependency.coercions
        .flatMap((coercion) => {
          const concrete = durableSymbols.get(coercion.concrete);
          const trait = durableSymbols.get(coercion.trait);
          const implementation = durableSymbols.get(coercion.implementation);
          const contract = packageInterface.summaries.find(
            (entry) => entry.id === coercion.summaryId,
          )?.summary.contract;
          if (!concrete || !trait || !implementation || !contract) return [];
          return (
            contract.parameters[0]?.returnedOrigins?.flatMap((origin) => {
              const result = origin.result[0];
              return result?.kind === "region"
                ? [
                    {
                      concrete,
                      trait,
                      implementation,
                      source: origin.source,
                      result,
                    },
                  ]
                : [];
            }) ?? []
          );
        })
        .map((projection) => [JSON.stringify(projection), projection] as const),
    ).values(),
  );
  const summaries = new Map(
    packageInterface.summaries.map(({ id, summary }) => [id, summary]),
  );
  const traitMethods = packageDependency.traitImplementations.flatMap(
    (implementation) =>
      implementation.methods.flatMap((method) => {
        const implementationRef = durableSymbols.get(method.implementation);
        const declaration = durableSymbols.get(method.declaration);
        const contract = summaries.get(method.summaryId)?.contract;
        return implementationRef && declaration && contract
          ? [{ implementation: implementationRef, declaration, contract }]
          : [];
      }),
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

const durableSymbolIndex = (
  dependencies: ReadonlyMap<string, SemanticsPipelineResult>,
): ReadonlyMap<string, import("../typing/symbol-ref.js").SymbolRef> => {
  const result = new Map<string, import("../typing/symbol-ref.js").SymbolRef>();
  dependencies.forEach((semantics, moduleId) => {
    const packageInterface = semantics.exports.packageSemanticInterface;
    if (!packageInterface) return;
    const summaryIdsToKeys = new Map<string, string>();
    packageInterface.exports.forEach((entry) => {
      [...entry.declarations, ...entry.members].forEach((declaration) => {
        if (declaration.summaryId) {
          summaryIdsToKeys.set(declaration.summaryId, declaration.key);
        }
      });
      const raw = semantics.exports.get(entry.name);
      (raw?.symbols ?? (raw ? [raw.symbol] : [])).forEach((symbol, index) => {
        const key = entry.declarations.at(index)?.key;
        if (key) result.set(key, { moduleId, symbol });
      });
      raw?.borrowing?.forEach((borrow) => {
        const key = summaryIdsToKeys.get(borrow.summaryId);
        if (key) result.set(key, { moduleId, symbol: borrow.symbol });
      });
    });
    const mapRef = (
      key: string | undefined,
      reference: import("../typing/symbol-ref.js").SymbolRef | undefined,
    ) => {
      if (key && reference) result.set(key, reference);
    };
    const rawCoercions = Array.from(semantics.exports.values()).flatMap(
      (entry) => entry.borrowingCoercions ?? [],
    );
    packageInterface.coercions.forEach((coercion, index) => {
      const raw = rawCoercions[index];
      mapRef(coercion.concrete, raw?.concrete);
      mapRef(coercion.trait, raw?.trait);
      mapRef(coercion.implementation, raw?.implementation);
      mapRef(coercion.resultType, raw?.resultType);
      coercion.applicability?.forEach((entry, applicabilityIndex) =>
        mapRef(
          entry.callable,
          raw?.applicability?.[applicabilityIndex]?.callable,
        ),
      );
    });
    const rawCallableCoercions = Array.from(semantics.exports.values()).flatMap(
      (entry) => entry.borrowingCallableResultCoercions ?? [],
    );
    packageInterface.callableResultCoercions.forEach((coercion, index) => {
      const raw = rawCallableCoercions[index];
      mapRef(coercion.concrete, raw?.concrete);
      mapRef(coercion.trait, raw?.trait);
      mapRef(coercion.implementation, raw?.implementation);
      mapRef(coercion.resultType, raw?.resultType);
    });
    packageInterface.traitImplementations.forEach(
      (implementation, implementationIndex) => {
        const raw =
          semantics.exports.borrowingTraitImplementations?.[
            implementationIndex
          ];
        mapRef(implementation.concrete, raw?.concrete);
        mapRef(implementation.trait, raw?.trait);
        mapRef(implementation.implementation, raw?.implementation);
        implementation.methods.forEach((method, methodIndex) => {
          mapRef(
            method.implementation,
            raw?.methods[methodIndex]?.implementation,
          );
          mapRef(method.declaration, raw?.methods[methodIndex]?.declaration);
        });
      },
    );
  });
  return result;
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
