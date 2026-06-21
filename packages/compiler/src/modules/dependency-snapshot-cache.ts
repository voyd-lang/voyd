import {
  createEffectInterner,
  type EffectInterner,
  type EffectInternerSnapshot,
} from "../semantics/effects/effect-table.js";
import type { SemanticsPipelineResult } from "../semantics/pipeline.js";
import {
  createTypeArena,
  type TypeArenaSnapshot,
} from "../semantics/typing/type-arena.js";
import { incrementCompilerPerfCounter } from "../perf.js";
import {
  cloneSemanticsMapForTypingState,
} from "./semantic-snapshot.js";
import type {
  ModuleDependency,
  ModuleGraph,
  ModuleNode,
  ModulePath,
  ModuleRoots,
} from "./types.js";
import type {
  ReusableDependencySemanticsSnapshot,
} from "./semantic-analysis.js";

const COMPILER_DEPENDENCY_SNAPSHOT_VERSION =
  "0.2.0:v375-dependency-snapshot-v1";

export type CompilerDependencySnapshotCache = {
  dependency?: CompilerDependencySnapshotEntry;
};

type CompilerDependencySnapshotEntry = {
  key: string;
  moduleFingerprints: ReadonlyMap<string, string>;
  moduleIds: readonly string[];
  arena: TypeArenaSnapshot;
  effectInterner: EffectInternerSnapshot;
  semantics: ReadonlyMap<string, SemanticsPipelineResult>;
};

export type PreparedDependencySnapshotReuse = {
  cache?: CompilerDependencySnapshotCache;
  key?: string;
  moduleFingerprints?: ReadonlyMap<string, string>;
  previousSemantics?: ReadonlyMap<string, SemanticsPipelineResult>;
  typingState?: {
    arena: SemanticsPipelineResult["typing"]["arena"];
    effectInterner: EffectInterner;
  };
  hit: boolean;
};

export const createCompilerDependencySnapshotCache =
  (): CompilerDependencySnapshotCache => ({});

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
  const cached = cache.dependency;
  if (!cached || cached.key !== key) {
    incrementCompilerPerfCounter("compiler.dependency_snapshot.miss");
    return { cache, key, moduleFingerprints, hit: false };
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
    moduleFingerprints,
    previousSemantics,
    typingState: { arena, effectInterner },
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

  const arena = createTypeArena(dependencySnapshot.arena);
  const effectInterner = createEffectInterner(dependencySnapshot.effectInterner);
  const semantics = cloneSemanticsMapForTypingState({
    semantics: dependencySnapshot.semantics,
    arena,
    effectInterner,
  });

  prepared.cache.dependency = {
    key: prepared.key,
    moduleFingerprints: prepared.moduleFingerprints,
    moduleIds: dependencySnapshot.moduleIds,
    arena: dependencySnapshot.arena,
    effectInterner: dependencySnapshot.effectInterner,
    semantics,
  };
  incrementCompilerPerfCounter("compiler.dependency_snapshot.write");
};

const dependencyModuleFingerprintsFor = (
  graph: ModuleGraph,
): ReadonlyMap<string, string> =>
  new Map(
    Array.from(graph.modules.entries())
      .filter(([, module]) => module.path.namespace !== "src")
      .sort(([left], [right]) => left.localeCompare(right, undefined, {
        numeric: true,
      }))
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
  moduleId.startsWith("pkg:") ? "pkg" : moduleId.split("::")[0] ?? "unknown";
