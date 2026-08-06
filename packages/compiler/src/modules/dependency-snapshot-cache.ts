import {
  createEffectInterner,
  type EffectInterner,
  type EffectInternerSnapshot,
} from "../semantics/effects/effect-table.js";
import type { SemanticsPipelineResult } from "../semantics/pipeline.js";
import type { BorrowingResult } from "../semantics/borrowing/index.js";
import {
  persistedBorrowQueryInput,
  persistedBorrowQueryOutput,
} from "../semantics/borrowing/query-digest.js";
import {
  createTypeArena,
  type TypeArenaSnapshot,
} from "../semantics/typing/type-arena.js";
import { incrementCompilerPerfCounter } from "../perf.js";
import { cloneSemanticsMapForTypingState } from "./semantic-snapshot.js";
import type {
  ModuleDependency,
  ModuleGraph,
  ModuleNode,
  ModulePath,
  ModuleRoots,
} from "./types.js";
import type { ReusableDependencySemanticsSnapshot } from "./semantic-analysis.js";
import { modulePathToString } from "./path.js";

const COMPILER_DEPENDENCY_SNAPSHOT_VERSION =
  "0.2.0:v375-dependency-snapshot-v2";
const COMPILER_BORROW_CACHE_VERSION =
  "0.1.0:v448-package-borrow-cache-v3" as const;
const COMPILER_BORROW_CACHE_SCHEMA =
  "voyd.compiler-dependency-borrow-cache" as const;

export type CompilerDependencyBorrowArtifact = {
  schema: typeof COMPILER_BORROW_CACHE_SCHEMA;
  version: typeof COMPILER_BORROW_CACHE_VERSION;
  key: string;
  payloadHash: string;
  modules: readonly {
    moduleId: string;
    fingerprint: string;
    borrowing: SerializedBorrowingResult;
  }[];
};

export type CompilerDependencySnapshotCache = {
  /** Whether this cache collects borrowing query state for artifact export. */
  artifactEnabled: boolean;
  dependency?: CompilerDependencySnapshotEntry;
  borrowArtifact?: CompilerDependencyBorrowArtifact;
};

type SerializedBorrowingResult = {
  callables: readonly (readonly [
    number,
    BorrowingResult["callables"] extends ReadonlyMap<number, infer V>
      ? V
      : never,
  ])[];
  capabilities: readonly (readonly [
    number,
    BorrowingResult["capabilities"] extends ReadonlyMap<number, infer V>
      ? V
      : never,
  ])[];
  namedContracts: readonly (readonly [
    number,
    BorrowingResult["namedContracts"] extends ReadonlyMap<number, infer V>
      ? V
      : never,
  ])[];
  runtimeIdentityGuards: readonly (readonly [number, readonly unknown[]])[];
  mutableStorageSymbols: readonly number[];
  diagnostics: BorrowingResult["diagnostics"];
  queries?: readonly (readonly [
    number,
    NonNullable<BorrowingResult["queries"]> extends ReadonlyMap<number, infer V>
      ? V
      : never,
  ])[];
};

type CompilerDependencySnapshotEntry = {
  key: string;
  borrowArtifactKey: string;
  moduleFingerprints: ReadonlyMap<string, string>;
  moduleIds: readonly string[];
  arena: TypeArenaSnapshot;
  effectInterner: EffectInternerSnapshot;
  semantics: ReadonlyMap<string, SemanticsPipelineResult>;
};

export type PreparedDependencySnapshotReuse = {
  cache?: CompilerDependencySnapshotCache;
  key?: string;
  borrowArtifactKey?: string;
  moduleFingerprints?: ReadonlyMap<string, string>;
  previousSemantics?: ReadonlyMap<string, SemanticsPipelineResult>;
  typingState?: {
    arena: SemanticsPipelineResult["typing"]["arena"];
    effectInterner: EffectInterner;
  };
  reusableBorrowing?: ReadonlyMap<string, BorrowingResult>;
  hit: boolean;
};

export const createCompilerDependencySnapshotCache = (
  borrowArtifact?: CompilerDependencyBorrowArtifact,
  { artifactEnabled = true }: { artifactEnabled?: boolean } = {},
): CompilerDependencySnapshotCache => ({
  artifactEnabled,
  ...(isCompilerDependencyBorrowArtifact(borrowArtifact)
    ? { borrowArtifact }
    : {}),
});

export const exportCompilerDependencyBorrowArtifact = (
  cache: CompilerDependencySnapshotCache | undefined,
): CompilerDependencyBorrowArtifact | undefined => {
  if (!cache?.artifactEnabled) {
    return undefined;
  }
  if (!cache?.dependency) {
    return cache?.borrowArtifact;
  }
  if (cache.borrowArtifact) {
    return cache.borrowArtifact;
  }

  const dependency = cache.dependency;
  const modules = dependency.moduleIds.flatMap((moduleId) => {
    const borrowing = dependency.semantics.get(moduleId)?.borrowing;
    const fingerprint = dependency.moduleFingerprints.get(moduleId);
    return borrowing && fingerprint
      ? [
          {
            moduleId,
            fingerprint,
            borrowing: serializeBorrowingResult(borrowing),
          },
        ]
      : [];
  });
  cache.borrowArtifact = {
    schema: COMPILER_BORROW_CACHE_SCHEMA,
    version: COMPILER_BORROW_CACHE_VERSION,
    key: dependency.borrowArtifactKey,
    payloadHash: persistedBorrowQueryInput(JSON.stringify(modules)),
    modules,
  };
  return cache.borrowArtifact;
};

export const prepareDependencySnapshotReuse = ({
  cache,
  graph,
  roots,
  includeTests,
}: {
  cache: CompilerDependencySnapshotCache | undefined;
  graph: ModuleGraph;
  roots: ModuleRoots;
  includeTests?: boolean;
}): PreparedDependencySnapshotReuse => {
  if (!cache || roots.resolvePackageRoot) {
    return { hit: false };
  }

  const moduleFingerprints = dependencyModuleFingerprintsFor(graph);
  if (moduleFingerprints.size === 0) {
    return { cache, hit: false };
  }

  const key = stableSerialize({
    compiler: COMPILER_DEPENDENCY_SNAPSHOT_VERSION,
    includeTests: includeTests === true,
    roots: serializableDependencyRoots(roots),
    modules: Array.from(moduleFingerprints.entries()),
  });
  const borrowArtifactKey = stableSerialize({
    compiler: COMPILER_BORROW_CACHE_VERSION,
    includeTests: includeTests === true,
    roots: serializableDependencyRoots(roots),
  });
  const cached = cache.dependency;
  const reusableBorrowing =
    isCompilerDependencyBorrowArtifact(cache.borrowArtifact) &&
    cache.borrowArtifact.key === borrowArtifactKey &&
    cache.borrowArtifact.version === COMPILER_BORROW_CACHE_VERSION
      ? reusableBorrowingFromArtifact({
          artifact: cache.borrowArtifact,
          graph,
          moduleFingerprints,
        })
      : undefined;
  if (!cached || cached.key !== key) {
    incrementCompilerPerfCounter("compiler.dependency_snapshot.miss");
    if (reusableBorrowing) {
      incrementCompilerPerfCounter("compiler.dependency_borrow_cache.hit");
    } else {
      incrementCompilerPerfCounter("compiler.dependency_borrow_cache.miss");
    }
    return {
      cache,
      key,
      borrowArtifactKey,
      moduleFingerprints,
      ...(reusableBorrowing ? { reusableBorrowing } : {}),
      hit: false,
    };
  }

  const arena = createTypeArena(cached.arena);
  const effectInterner = createEffectInterner(cached.effectInterner);
  const previousSemantics = cloneSemanticsMapForTypingState({
    semantics: cached.semantics,
    arena,
    effectInterner,
  });

  incrementCompilerPerfCounter("compiler.dependency_snapshot.hit");
  cached.moduleIds.forEach((moduleId) =>
    incrementCompilerPerfCounter(
      `compiler.dependency_snapshot.reuse.${moduleNamespaceForId(moduleId)}.count`,
    ),
  );

  return {
    cache,
    key,
    borrowArtifactKey,
    moduleFingerprints,
    previousSemantics,
    typingState: { arena, effectInterner },
    ...(reusableBorrowing ? { reusableBorrowing } : {}),
    hit: true,
  };
};

export const commitDependencySnapshot = ({
  prepared,
  dependencySnapshot,
}: {
  prepared: PreparedDependencySnapshotReuse | undefined;
  dependencySnapshot: ReusableDependencySemanticsSnapshot | undefined;
}): void => {
  if (
    !prepared?.cache ||
    !prepared.key ||
    !prepared.moduleFingerprints ||
    !dependencySnapshot
  ) {
    return;
  }

  const snapshotIds = new Set(dependencySnapshot.moduleIds);
  const fingerprintIds = new Set(prepared.moduleFingerprints.keys());
  if (
    snapshotIds.size !== fingerprintIds.size ||
    Array.from(fingerprintIds).some((moduleId) => !snapshotIds.has(moduleId))
  ) {
    return;
  }

  prepared.cache.dependency = {
    key: prepared.key,
    borrowArtifactKey: prepared.borrowArtifactKey ?? prepared.key,
    moduleFingerprints: prepared.moduleFingerprints,
    moduleIds: dependencySnapshot.moduleIds,
    arena: dependencySnapshot.arena,
    effectInterner: dependencySnapshot.effectInterner,
    semantics: dependencySnapshot.semantics,
  };
  prepared.cache.borrowArtifact = undefined;
  incrementCompilerPerfCounter("compiler.dependency_snapshot.write");
};

const reusableBorrowingFromArtifact = ({
  artifact,
  graph,
  moduleFingerprints,
}: {
  artifact: CompilerDependencyBorrowArtifact;
  graph: ModuleGraph;
  moduleFingerprints: ReadonlyMap<string, string>;
}): ReadonlyMap<string, BorrowingResult> => {
  const cachedByModuleId = new Map(
    artifact.modules.map((entry) => [entry.moduleId, entry]),
  );
  const invalid = new Set(
    Array.from(moduleFingerprints).flatMap(([moduleId, fingerprint]) =>
      cachedByModuleId.get(moduleId)?.fingerprint === fingerprint
        ? []
        : [moduleId],
    ),
  );
  const reverseDependencies = new Map<string, Set<string>>();
  graph.modules.forEach((module) => {
    module.dependencies.forEach((dependency) => {
      const dependencyId = modulePathToString(dependency.path);
      const dependents = reverseDependencies.get(dependencyId) ?? new Set();
      dependents.add(module.id);
      reverseDependencies.set(dependencyId, dependents);
    });
  });
  const queue = Array.from(invalid);
  for (let index = 0; index < queue.length; index += 1) {
    (reverseDependencies.get(queue[index]!) ?? []).forEach((dependent) => {
      if (invalid.has(dependent)) return;
      invalid.add(dependent);
      queue.push(dependent);
    });
  }
  return new Map(
    Array.from(moduleFingerprints.keys()).flatMap((moduleId) => {
      const cached = cachedByModuleId.get(moduleId);
      return cached && !invalid.has(moduleId)
        ? [[moduleId, deserializeBorrowingResult(cached.borrowing)] as const]
        : [];
    }),
  );
};

const dependencyModuleFingerprintsFor = (
  graph: ModuleGraph,
): ReadonlyMap<string, string> =>
  new Map(
    Array.from(graph.modules.entries())
      .filter(([, module]) => module.path.namespace !== "src")
      .sort(([left], [right]) =>
        left.localeCompare(right, undefined, {
          numeric: true,
        }),
      )
      .map(([moduleId, module]) => [moduleId, moduleFingerprint(module)]),
  );

const moduleFingerprint = (module: ModuleNode): string =>
  stableSerialize({
    id: module.id,
    path: serializableModulePath(module.path),
    origin: module.origin,
    source: module.source,
    sourceFiles: module.sourceFiles ?? [],
    sourcePackageRoot: module.sourcePackageRoot ?? [],
    dependencies: module.dependencies
      .map(serializableDependency)
      .sort((left, right) =>
        stableSerialize(left).localeCompare(stableSerialize(right)),
      ),
    macroExports: [...(module.macroExports ?? [])].sort(),
  });

const serializableDependency = (dependency: ModuleDependency) => ({
  kind: dependency.kind,
  path: serializableModulePath(dependency.path),
  namespaceFallbackPath: dependency.namespaceFallbackPath
    ? serializableModulePath(dependency.namespaceFallbackPath)
    : undefined,
});

const serializableModulePath = (modulePath: ModulePath) => ({
  namespace: modulePath.namespace,
  packageName: modulePath.packageName,
  segments: [...modulePath.segments],
});

const serializableDependencyRoots = (roots: ModuleRoots) => ({
  std: roots.std,
  pkg: roots.pkg,
  pkgDirs: [...(roots.pkgDirs ?? [])],
});

const stableSerialize = (value: unknown): string =>
  JSON.stringify(sortForStableSerialization(value));

const sortForStableSerialization = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(sortForStableSerialization);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  if (value instanceof Uint8Array) {
    return Array.from(value);
  }
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, sortForStableSerialization(record[key])]),
  );
};

const moduleNamespaceForId = (moduleId: string): string =>
  moduleId.startsWith("pkg:") ? "pkg" : (moduleId.split("::")[0] ?? "unknown");

const serializeBorrowingResult = (
  borrowing: BorrowingResult,
): SerializedBorrowingResult => ({
  callables: Array.from(borrowing.callables),
  capabilities: Array.from(borrowing.capabilities),
  namedContracts: Array.from(borrowing.namedContracts),
  runtimeIdentityGuards: Array.from(borrowing.runtimeIdentityGuards),
  mutableStorageSymbols: Array.from(borrowing.mutableStorageSymbols),
  diagnostics: borrowing.diagnostics,
  ...(borrowing.queries
    ? {
        queries: Array.from(
          borrowing.queries,
          ([symbol, query]) =>
            [
              symbol,
              {
                ...query,
                input: persistedBorrowQueryInput(query.input),
                dependencyOutputs: query.dependencyOutputs.map(
                  ([key, output]) =>
                    [key, persistedBorrowQueryOutput(output)] as const,
                ),
              },
            ] as const,
        ),
      }
    : {}),
});

const deserializeBorrowingResult = (
  borrowing: SerializedBorrowingResult,
): BorrowingResult => ({
  callables: new Map(borrowing.callables),
  capabilities: new Map(borrowing.capabilities),
  namedContracts: new Map(borrowing.namedContracts),
  runtimeIdentityGuards: new Map(
    borrowing.runtimeIdentityGuards,
  ) as BorrowingResult["runtimeIdentityGuards"],
  mutableStorageSymbols: new Set(borrowing.mutableStorageSymbols),
  diagnostics: borrowing.diagnostics,
  ...(borrowing.queries ? { queries: new Map(borrowing.queries) } : {}),
});

const isCompilerDependencyBorrowArtifact = (
  value: unknown,
): value is CompilerDependencyBorrowArtifact => {
  if (!isRecord(value)) return false;
  if (
    value.schema !== COMPILER_BORROW_CACHE_SCHEMA ||
    value.version !== COMPILER_BORROW_CACHE_VERSION ||
    typeof value.key !== "string" ||
    typeof value.payloadHash !== "string" ||
    !Array.isArray(value.modules)
  ) {
    return false;
  }
  if (!hasValidPayloadHash(value.payloadHash, value.modules)) {
    return false;
  }
  return value.modules.every((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.moduleId !== "string" ||
      typeof entry.fingerprint !== "string" ||
      !isRecord(entry.borrowing)
    ) {
      return false;
    }
    const borrowing = entry.borrowing;
    return (
      isNumberTupleArray(borrowing.callables, isCallableContract) &&
      isNumberTupleArray(
        borrowing.capabilities,
        (item) =>
          item === "none" || item === "transient" || item === "flow-sensitive",
      ) &&
      isNumberTupleArray(borrowing.namedContracts, isNamedContract) &&
      isNumberTupleArray(
        borrowing.runtimeIdentityGuards,
        (guards) => Array.isArray(guards) && guards.every(isRuntimeGuard),
      ) &&
      isNumberArray(borrowing.mutableStorageSymbols) &&
      Array.isArray(borrowing.diagnostics) &&
      borrowing.diagnostics.every(isDiagnostic) &&
      (borrowing.queries === undefined ||
        isNumberTupleArray(borrowing.queries, isSerializedQuery))
    );
  });
};

const isSerializedQuery = (value: unknown): boolean =>
  isRecord(value) &&
  typeof value.input === "string" &&
  Array.isArray(value.dependencies) &&
  value.dependencies.every(
    (entry) =>
      isRecord(entry) &&
      typeof entry.moduleId === "string" &&
      typeof entry.symbol === "number",
  ) &&
  Array.isArray(value.dependencyOutputs) &&
  value.dependencyOutputs.every(
    (entry) =>
      Array.isArray(entry) &&
      entry.length === 2 &&
      typeof entry[0] === "string" &&
      (typeof entry[1] === "string" ||
        entry[1] === null ||
        isCallableContract(entry[1])),
  ) &&
  isCallableContract(value.output);

const hasValidPayloadHash = (hash: string, modules: unknown): boolean => {
  try {
    return hash === persistedBorrowQueryInput(JSON.stringify(modules));
  } catch {
    return false;
  }
};

const isCallableContract = (value: unknown, depth = 0): boolean =>
  depth <= 16 &&
  isRecord(value) &&
  typeof value.maySuspend === "boolean" &&
  Array.isArray(value.parameters) &&
  value.parameters.every(isCallableParameterContract) &&
  isOptionalTrue(value.freshResult) &&
  (value.defaultIdentityGuardProtocol === undefined ||
    value.defaultIdentityGuardProtocol === "presence-conflict-bit-v1") &&
  (value.borrowedResult === undefined ||
    value.borrowedResult === "none" ||
    value.borrowedResult === "parameter" ||
    value.borrowedResult === "external") &&
  isOptionalArray(value.externalReturnedOrigins, isExternalReturnedOrigin) &&
  isOptionalTrue(value.externalRead) &&
  isOptionalTrue(value.externalWrite) &&
  isOptionalArray(value.transfers, isCallableBorrowTransfer) &&
  isOptionalArray(value.scopedCallbacks, isScopedCallbackContract) &&
  isOptionalArray(
    value.callableResultInvocations,
    isCallableResultInvocation,
  ) &&
  (value.dynamicDispatch === undefined ||
    isCallableContract(value.dynamicDispatch, depth + 1));

const isCallableParameterContract = (value: unknown): boolean =>
  isRecord(value) &&
  (value.access === "owned" ||
    value.access === "shared" ||
    value.access === "mutable") &&
  typeof value.retained === "boolean" &&
  typeof value.returned === "boolean" &&
  isOptionalPathArray(value.readPaths) &&
  isOptionalPathArray(value.writePaths) &&
  isOptionalTrue(value.runtimeCheckedWrites) &&
  isOptionalTrue(value.retainedUnlessBorrowed) &&
  isOptionalTrue(value.returnedAggregate) &&
  isOptionalPathArray(value.retainedPaths) &&
  isOptionalPathArray(value.externalRetainedPaths) &&
  isOptionalPathArray(value.borrowedRetainedPaths) &&
  isOptionalPathArray(value.returnedPaths) &&
  isOptionalArray(value.returnedOrigins, isReturnedBorrowOrigin) &&
  isOptionalArray(value.returnedSharedOrigins, isReturnedBorrowOrigin) &&
  isOptionalArray(
    value.returnedTypeMatchingOrigins,
    (origin) =>
      isRecord(origin) &&
      typeof origin.conditionId === "string" &&
      isReturnedBorrowOrigin(origin),
  ) &&
  (value.accessIfResultTypeDiffers === undefined ||
    isBorrowTypeComparison(value.accessIfResultTypeDiffers)) &&
  isOptionalPathArray(value.invalidatedPaths) &&
  isOptionalArray(value.defaultOrigins, isDefaultBorrowOrigin) &&
  isOptionalArray(value.defaultReadOrigins, isDefaultBorrowAccessOrigin) &&
  isOptionalArray(value.defaultWriteOrigins, isDefaultBorrowAccessOrigin) &&
  isOptionalArray(value.defaultExternalOrigins, isExternalReturnedOrigin) &&
  isOptionalArray(
    value.defaultExternalReturnedOrigins,
    isExternalReturnedOrigin,
  ) &&
  isOptionalTrue(value.defaultExternalRead) &&
  isOptionalTrue(value.defaultExternalWrite) &&
  (value.defaultBorrowedResult === undefined ||
    value.defaultBorrowedResult === "none") &&
  isOptionalPathArray(value.defaultNoBorrowPaths);

const isReturnedBorrowOrigin = (value: unknown): boolean =>
  isRecord(value) &&
  isProjectionArray(value.source) &&
  isProjectionArray(value.result) &&
  isOptionalEndpointAccess(value.endpointAccess) &&
  isOptionalTrue(value.defaultNoBorrow);

const isDefaultBorrowOrigin = (value: unknown): boolean =>
  isRecord(value) &&
  typeof value.parameter === "number" &&
  isProjectionArray(value.source) &&
  isProjectionArray(value.result) &&
  isOptionalEndpointAccess(value.endpointAccess);

const isDefaultBorrowAccessOrigin = (value: unknown): boolean =>
  isRecord(value) &&
  typeof value.parameter === "number" &&
  isProjectionArray(value.path);

const isExternalReturnedOrigin = (value: unknown): boolean =>
  isRecord(value) &&
  isProjectionArray(value.result) &&
  isOptionalEndpointAccess(value.endpointAccess) &&
  isOptionalTrue(value.fresh);

const isBorrowTypeComparison = (value: unknown): boolean =>
  isRecord(value) &&
  typeof value.conditionId === "string" &&
  typeof value.parameter === "number" &&
  isProjectionArray(value.sourcePath) &&
  isProjectionArray(value.resultPath) &&
  isOptionalEndpointAccess(value.endpointAccess);

const isCallableBorrowTransfer = (value: unknown): boolean =>
  isRecord(value) &&
  typeof value.sourceParameter === "number" &&
  typeof value.destinationParameter === "number" &&
  (value.sourcePath === undefined || isProjectionArray(value.sourcePath)) &&
  (value.destinationPath === undefined ||
    isProjectionArray(value.destinationPath)) &&
  isOptionalTrue(value.sourceInvalidated) &&
  isOptionalTrue(value.borrowsSource) &&
  isOptionalTrue(value.conservative);

const isScopedCallbackContract = (value: unknown): boolean =>
  isRecord(value) &&
  typeof value.callbackParameter === "number" &&
  typeof value.callbackValueParameter === "number" &&
  (value.access === "shared" || value.access === "mutable") &&
  (value.callbackPath === undefined || isStringArray(value.callbackPath)) &&
  (value.defaultCallbackBehavior === undefined ||
    value.defaultCallbackBehavior === "safe" ||
    value.defaultCallbackBehavior === "escapes" ||
    value.defaultCallbackBehavior === "unknown");

const isCallableResultInvocation = (value: unknown): boolean =>
  isRecord(value) &&
  typeof value.parameter === "number" &&
  isProjectionArray(value.source) &&
  isProjectionArray(value.callbackResult) &&
  (value.callbackResultType === undefined ||
    isSymbolRef(value.callbackResultType)) &&
  isProjectionArray(value.result);

const isNamedContract = (value: unknown): boolean =>
  isRecord(value) &&
  typeof value.scope === "string" &&
  typeof value.declaration === "number" &&
  typeof value.trait === "number" &&
  (value.implementation === undefined ||
    typeof value.implementation === "number") &&
  Array.isArray(value.regions) &&
  value.regions.every(
    (region) =>
      isRecord(region) &&
      typeof region.name === "string" &&
      (region.parameter === undefined ||
        typeof region.parameter === "number") &&
      (region.place === undefined || isProjectionArray(region.place)),
  ) &&
  isStringArray(value.reads) &&
  isStringArray(value.mutates) &&
  isStringArray(value.returnsFrom) &&
  Array.isArray(value.disjoint) &&
  value.disjoint.every(
    (entry) =>
      Array.isArray(entry) &&
      entry.length === 2 &&
      typeof entry[0] === "string" &&
      typeof entry[1] === "string",
  );

const isRuntimeGuard = (value: unknown): boolean =>
  isRecord(value) &&
  typeof value.call === "number" &&
  isSymbolRef(value.target) &&
  isRuntimeGuardOperand(value.left) &&
  isRuntimeGuardOperand(value.right) &&
  (value.afterDefaults === undefined || value.afterDefaults === true) &&
  (value.defaultIdentityGuardProtocol === undefined ||
    value.defaultIdentityGuardProtocol === "presence-conflict-bit-v1") &&
  (value.omittedParameters === undefined ||
    isNumberArray(value.omittedParameters));

const isRuntimeGuardOperand = (value: unknown): boolean =>
  isRecord(value) &&
  typeof value.parameter === "number" &&
  typeof value.expression === "number" &&
  typeof value.display === "string" &&
  (value.identity === "allocation" ||
    value.identity === "storage" ||
    value.identity === "indexed-place") &&
  isRecord(value.place) &&
  typeof value.place.root === "number" &&
  isProjectionArray(value.place.projections) &&
  (value.allocationPath === undefined ||
    isProjectionArray(value.allocationPath));

const isProjectionArray = (value: unknown): boolean =>
  Array.isArray(value) &&
  value.every((projection) => {
    if (!isRecord(projection)) return false;
    switch (projection.kind) {
      case "field":
        return typeof projection.name === "string";
      case "tuple":
        return typeof projection.index === "number";
      case "index":
        return (
          typeof projection.stable === "boolean" &&
          (projection.constant === undefined ||
            typeof projection.constant === "number")
        );
      case "region":
        return (
          typeof projection.scope === "string" &&
          typeof projection.name === "string" &&
          isStringArray(projection.disjoint)
        );
      case "discriminant":
      case "dereference":
      case "identity":
        return true;
      default:
        return false;
    }
  });

const isDiagnostic = (value: unknown): boolean =>
  isRecord(value) &&
  typeof value.code === "string" &&
  typeof value.message === "string" &&
  (value.severity === "error" ||
    value.severity === "warning" ||
    value.severity === "note") &&
  isRecord(value.span) &&
  typeof value.span.file === "string" &&
  typeof value.span.start === "number" &&
  typeof value.span.end === "number" &&
  (value.phase === undefined ||
    ["module-graph", "binder", "typing", "lowering", "codegen"].includes(
      value.phase as string,
    )) &&
  (value.hints === undefined ||
    (Array.isArray(value.hints) &&
      value.hints.every(
        (hint) =>
          isRecord(hint) &&
          typeof hint.message === "string" &&
          (hint.docLink === undefined || typeof hint.docLink === "string"),
      ))) &&
  (value.related === undefined ||
    (Array.isArray(value.related) && value.related.every(isDiagnostic)));

const isSymbolRef = (value: unknown): boolean =>
  isRecord(value) &&
  typeof value.moduleId === "string" &&
  typeof value.symbol === "number";

const isStringArray = (value: unknown): boolean =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

const isOptionalArray = (
  value: unknown,
  isValue: (value: unknown) => boolean,
): boolean =>
  value === undefined || (Array.isArray(value) && value.every(isValue));

const isOptionalPathArray = (value: unknown): boolean =>
  isOptionalArray(value, isProjectionArray);

const isOptionalEndpointAccess = (value: unknown): boolean =>
  value === undefined || value === "inline" || value === "dereferenced";

const isOptionalTrue = (value: unknown): boolean =>
  value === undefined || value === true;

const isNumberTupleArray = (
  value: unknown,
  isValue: (value: unknown) => boolean,
): boolean =>
  Array.isArray(value) &&
  value.every(
    (entry) =>
      Array.isArray(entry) &&
      entry.length === 2 &&
      typeof entry[0] === "number" &&
      isValue(entry[1]),
  );

const isNumberArray = (value: unknown): boolean =>
  Array.isArray(value) && value.every((entry) => typeof entry === "number");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
