import { incrementCompilerPerfCounter } from "../../perf.js";
import type {
  PackageOrdinaryMutationSummary,
  PackageCallableSignature,
  PackageSemanticInterface,
} from "../modules.js";
import {
  PACKAGE_SEMANTIC_INTERFACE_SCHEMA,
  PACKAGE_SEMANTIC_INTERFACE_VERSION,
} from "../modules.js";
import type { SemanticsPipelineResult } from "../pipeline.js";
import { canonicalSymbolRef } from "../typing/symbol-ref-utils.js";
import type { BorrowingDependency } from "./dependency.js";

/**
 * Durable, symbol-arena-independent dependency view. Package interfaces carry
 * signatures, effect behavior, and bounded ordinary-mutation facts only.
 */
export type PackageBorrowingDependency = {
  callables: ReadonlyMap<
    string,
    {
      name: string;
      signature?: PackageCallableSignature;
      ordinaryMutationSummary?: PackageOrdinaryMutationSummary;
      defaultIdentityGuardProtocol?: "presence-conflict-bit-v1";
    }
  >;
  effectOperations: ReadonlyMap<
    string,
    { name: string; maySuspend: boolean; signature?: PackageCallableSignature }
  >;
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
  const ordinaryMutationSummaries = new Map(
    packageInterface.ordinaryMutationSummaries.map(({ id, summary }) => [
      id,
      summary,
    ]),
  );
  const callables = new Map<
    string,
    {
      name: string;
      signature?: PackageCallableSignature;
      ordinaryMutationSummary?: PackageOrdinaryMutationSummary;
      defaultIdentityGuardProtocol?: "presence-conflict-bit-v1";
    }
  >();
  const effectOperations = new Map<
    string,
    { name: string; maySuspend: boolean; signature?: PackageCallableSignature }
  >();
  packageInterface.exports.forEach((entry) => {
    entry.declarations.forEach((declaration) => {
      if (
        !declaration.signature &&
        !declaration.ordinaryMutationSummaryId &&
        !declaration.defaultIdentityGuardProtocol
      ) {
        return;
      }
      callables.set(declaration.key, {
        name: entry.name,
        ...(declaration.signature ? { signature: declaration.signature } : {}),
        ...(declaration.ordinaryMutationSummaryId
          ? {
              ordinaryMutationSummary: ordinaryMutationSummaries.get(
                declaration.ordinaryMutationSummaryId,
              ),
            }
          : {}),
        ...(declaration.defaultIdentityGuardProtocol
          ? {
              defaultIdentityGuardProtocol:
                declaration.defaultIdentityGuardProtocol,
            }
          : {}),
      });
    });
    entry.members.forEach((member) => {
      const projected = {
        name: member.name,
        ...(member.signature ? { signature: member.signature } : {}),
        ...(member.ordinaryMutationSummaryId
          ? {
              ordinaryMutationSummary: ordinaryMutationSummaries.get(
                member.ordinaryMutationSummaryId,
              ),
            }
          : {}),
        ...(member.defaultIdentityGuardProtocol
          ? {
              defaultIdentityGuardProtocol: member.defaultIdentityGuardProtocol,
            }
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
  return { callables, effectOperations };
};

export const projectBorrowingDependencies = (
  dependencies: ReadonlyMap<string, SemanticsPipelineResult> | undefined,
  cache: BorrowingDependencyProjectionCache = defaultBorrowingDependencyProjectionCache,
): ReadonlyMap<string, BorrowingDependency> => {
  const projected = new Map<string, BorrowingDependency>();
  Array.from(dependencies ?? []).forEach(([moduleId, semantics]) => {
    const contribution = cachedBorrowingDependencyProjection({
      moduleId,
      semantics,
      cache,
    });
    projected.set(
      moduleId,
      mergeBorrowingDependency(projected.get(moduleId), contribution),
    );
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
    if (dependency) selected.set(moduleId, dependency);
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
    stats: { hits: 0, misses: 0 },
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
    Map<string, BorrowingDependencyProjectionCacheEntry>
  >;
  readonly stats: BorrowingDependencyProjectionCacheStats;
};

type BorrowingDependencyProjectionCacheEntry = {
  dependency: BorrowingDependency;
  packageInterface: PackageSemanticInterface | undefined;
  ordinaryMutationSummaries: SemanticsPipelineResult["borrowing"]["ordinaryMutationSummaries"];
  defaultIdentityGuardTargets: SemanticsPipelineResult["borrowing"]["defaultIdentityGuardTargets"];
};

const defaultBorrowingDependencyProjectionCache =
  createBorrowingDependencyProjectionCache();

const cachedBorrowingDependencyProjection = ({
  moduleId,
  semantics,
  cache,
}: {
  moduleId: string;
  semantics: SemanticsPipelineResult;
  cache: BorrowingDependencyProjectionCache;
}): BorrowingDependency => {
  const cached = cache.entries.get(semantics)?.get(moduleId);
  if (
    cached &&
    cached.packageInterface === semantics.exports.packageSemanticInterface &&
    cached.ordinaryMutationSummaries ===
      semantics.borrowing.ordinaryMutationSummaries &&
    cached.defaultIdentityGuardTargets ===
      semantics.borrowing.defaultIdentityGuardTargets
  ) {
    cache.stats.hits += 1;
    incrementCompilerPerfCounter("borrowing.dependencyProjection.cacheHit");
    return cached.dependency;
  }
  cache.stats.misses += 1;
  incrementCompilerPerfCounter("borrowing.dependencyProjection.cacheMiss");
  const projection = buildBorrowingDependencyProjection({
    moduleId,
    semantics,
  });
  const entries = cache.entries.get(semantics) ?? new Map();
  entries.set(moduleId, {
    dependency: projection,
    packageInterface: semantics.exports.packageSemanticInterface,
    ordinaryMutationSummaries: semantics.borrowing.ordinaryMutationSummaries,
    defaultIdentityGuardTargets:
      semantics.borrowing.defaultIdentityGuardTargets,
  });
  cache.entries.set(semantics, entries);
  return projection;
};

const buildBorrowingDependencyProjection = ({
  moduleId,
  semantics,
}: {
  moduleId: string;
  semantics: SemanticsPipelineResult;
}): BorrowingDependency => {
  const packageInterface = semantics.exports.packageSemanticInterface;
  if (!packageInterface) {
    throw new Error(`missing package semantic interface for ${moduleId}`);
  }
  const packageDependency = projectPackageSemanticInterface(packageInterface);
  const ordinarySummaryIdsToKeys = new Map<string, string>();
  const traitMethodKeys = new Set<string>();
  packageInterface.exports.forEach((entry) => {
    [...entry.declarations, ...entry.members].forEach((declaration) => {
      if (declaration.ordinaryMutationSummaryId) {
        ordinarySummaryIdsToKeys.set(
          declaration.ordinaryMutationSummaryId,
          declaration.key,
        );
      }
    });
    entry.members.forEach((member) => {
      if (member.kind === "trait-method") traitMethodKeys.add(member.key);
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
    entry.ordinaryMutation?.forEach((ordinary) => {
      const key = ordinarySummaryIdsToKeys.get(ordinary.summaryId);
      if (key) keysBySymbol.set(ordinary.symbol, key);
    });
  });
  Array.from(semantics.hir.items.values()).forEach((item) => {
    if (item.kind !== "trait" && item.kind !== "effect") return;
    const ownerName = semantics.binding.symbolTable.getSymbol(item.symbol).name;
    const stable = packageInterface.exports.find(
      (entry) => entry.name === ownerName,
    );
    const members = item.kind === "trait" ? item.methods : item.operations;
    members.forEach((member, index) => {
      const key = stable?.members.at(index)?.key;
      if (key) keysBySymbol.set(member.symbol, key);
    });
  });
  const projectedCallables = new Map(
    Array.from(keysBySymbol).flatMap(([symbol, key]) => {
      const projected = packageDependency.callables.get(key);
      if (!projected) return [];
      const signature = semantics.typing.functions.getSignature(symbol);
      return [
        [
          symbol,
          {
            name: projected.name,
            ...(signature ? { signature } : {}),
            ordinaryMutationSummary:
              semantics.borrowing.ordinaryMutationSummaries.get(symbol) ??
              projected.ordinaryMutationSummary,
            defaultIdentityGuardProtocol:
              projected.defaultIdentityGuardProtocol,
          },
        ] as const,
      ];
    }),
  );
  semantics.typing.traitMethodImpls.forEach((_mapping, implementation) => {
    const signature = semantics.typing.functions.getSignature(implementation);
    const ordinaryMutationSummary =
      semantics.borrowing.ordinaryMutationSummaries.get(implementation);
    if (!signature || !ordinaryMutationSummary) return;
    projectedCallables.set(implementation, {
      name: semantics.binding.symbolTable.getSymbol(implementation).name,
      signature,
      ordinaryMutationSummary,
      defaultIdentityGuardProtocol:
        semantics.borrowing.defaultIdentityGuardTargets.has(implementation)
          ? "presence-conflict-bit-v1"
          : undefined,
    });
  });
  const callables = new Map(
    Array.from(projectedCallables, ([symbol, callable]) => [
      symbol,
      {
        name: callable.name,
        ...(callable.signature ? { signature: callable.signature } : {}),
      },
    ]),
  );
  const ordinaryMutationSummaries = new Map(
    Array.from(projectedCallables).flatMap(([symbol, callable]) =>
      callable.ordinaryMutationSummary
        ? [[symbol, callable.ordinaryMutationSummary] as const]
        : [],
    ),
  );
  const defaultIdentityGuardTargets = new Set(
    Array.from(projectedCallables).flatMap(([symbol, callable]) =>
      callable.defaultIdentityGuardProtocol === "presence-conflict-bit-v1"
        ? [symbol]
        : [],
    ),
  );
  const effectOperations = new Map(
    Array.from(keysBySymbol).flatMap(([symbol, key]) => {
      const operation = packageDependency.effectOperations.get(key);
      return operation
        ? [[symbol, { maySuspend: operation.maySuspend }] as const]
        : [];
    }),
  );
  const traitMethodDeclarations = new Map(
    [
      ...Array.from(keysBySymbol).flatMap(([symbol, key]) =>
        traitMethodKeys.has(key) ? [[symbol, { moduleId, symbol }] as const] : [],
      ),
      ...Array.from(
        semantics.typing.traitMethodImpls,
        ([implementation, mapping]) =>
          [
            implementation,
            canonicalSymbolRef({
              symbol: mapping.traitMethodSymbol,
              symbolTable: semantics.binding.symbolTable,
              moduleId,
            }),
          ] as const,
      ),
    ],
  );
  return {
    callables,
    ordinaryMutationSummaries,
    defaultIdentityGuardTargets,
    effectOperations,
    traitMethodDeclarations,
  };
};

const mergeBorrowingDependency = (
  existing: BorrowingDependency | undefined,
  contribution: BorrowingDependency,
): BorrowingDependency => {
  if (!existing) return contribution;
  return {
    callables: new Map([...existing.callables, ...contribution.callables]),
    ordinaryMutationSummaries: new Map([
      ...existing.ordinaryMutationSummaries,
      ...contribution.ordinaryMutationSummaries,
    ]),
    defaultIdentityGuardTargets: new Set([
      ...existing.defaultIdentityGuardTargets,
      ...contribution.defaultIdentityGuardTargets,
    ]),
    effectOperations: new Map([
      ...existing.effectOperations,
      ...contribution.effectOperations,
    ]),
    traitMethodDeclarations: new Map([
      ...existing.traitMethodDeclarations,
      ...contribution.traitMethodDeclarations,
    ]),
  };
};
