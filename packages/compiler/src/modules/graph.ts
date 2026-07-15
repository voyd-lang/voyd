import {
  Form,
  InternalIdentifierAtom,
  formCallsInternal,
  isIdentifierAtom,
  isForm,
  parserErrorLocation,
  parseBase,
  createModuleHeaderView,
} from "../parser/index.js";
import { diagnosticFromCode, type Diagnostic } from "../diagnostics/index.js";
import {
  collectModuleDocumentation,
  combineDocumentation,
  type ModuleDocumentation,
} from "../docs/doc-comments.js";
import { toSourceSpan } from "../parser/surface/utils.js";
import {
  modulePathFromFile,
  modulePathToString,
  resolveModuleFile,
} from "./path.js";
import { resolveModuleRequest } from "./resolve.js";
import type { TopLevelDeclClassification } from "../parser/surface/use-decl.js";
import { moduleDiagnosticToDiagnostic } from "./diagnostics.js";
import type {
  ModuleDependency,
  ModuleDiagnostic,
  ModuleGraph,
  ModuleHost,
  ModuleNode,
  ModulePath,
  ModuleRoots,
} from "./types.js";
import { createModuleMacroExpander } from "./macro-expansion.js";
import type { SourceSpan } from "../semantics/ids.js";
import {
  incrementCompilerPerfCounter,
  isCompilerPerfEnabled,
  recordCompilerPerfDuration,
} from "../perf.js";

type BuildGraphOptions = {
  entryPath: string;
  host: ModuleHost;
  roots: ModuleRoots;
  includeTests?: boolean;
};

type PendingDependency = {
  dependency: ModuleDependency;
  importerId: string;
  importerFilePath?: string;
};

const NO_PRELUDE_DIRECTIVE =
  /(^|[\r\n])([^\S\r\n]*#!no_prelude[^\r\n]*)(?=$|[\r\n])/g;
const PRELUDE_MODULE_SEGMENTS = ["std", "prelude"] as const;
const IMPLICIT_PRELUDE_USE_DECL = (() => {
  const ast = parseBase("use std::prelude::all", "<implicit-prelude>");
  if (!formCallsInternal(ast, "ast")) {
    throw new Error("failed to parse implicit prelude import");
  }
  const entry = ast.rest[0];
  if (!isForm(entry)) {
    throw new Error("failed to parse implicit prelude use declaration");
  }
  return entry;
})();

const formatErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const RESERVED_MODULE_SEGMENT = "all";

const findReservedModuleSegment = (path: ModulePath): string | undefined =>
  path.segments.find((segment) => segment === RESERVED_MODULE_SEGMENT);

const COMPILER_PERF_ENABLED = isCompilerPerfEnabled();

const updateNestedPrefixCounts = ({
  counts,
  pathKey,
  delta,
}: {
  counts: Map<string, number>;
  pathKey: string;
  delta: 1 | -1;
}): void => {
  const segments = pathKey.split("::");
  for (let length = 1; length < segments.length; length += 1) {
    const prefix = segments.slice(0, length).join("::");
    const next = (counts.get(prefix) ?? 0) + delta;
    if (next <= 0) {
      counts.delete(prefix);
    } else {
      counts.set(prefix, next);
    }
  }
};

const hasAvailableModulePath = ({
  path,
  modulesByPath,
  moduleNestedPrefixCounts,
}: {
  path: ModulePath;
  modulesByPath: ReadonlyMap<string, ModuleNode>;
  moduleNestedPrefixCounts: ReadonlyMap<string, number>;
}): boolean => {
  const pathKey = modulePathToString(path);
  return (
    modulesByPath.has(pathKey) ||
    (moduleNestedPrefixCounts.get(pathKey) ?? 0) > 0
  );
};

const reachableModuleIds = ({
  entry,
  modules,
}: {
  entry: string;
  modules: ReadonlyMap<string, ModuleNode>;
}): Set<string> => {
  const inlineChildren = new Map<string, string[]>();
  modules.forEach((module) => {
    if (module.origin.kind !== "inline") {
      return;
    }
    const children = inlineChildren.get(module.origin.parentId) ?? [];
    children.push(module.id);
    inlineChildren.set(module.origin.parentId, children);
  });

  const reachable = new Set<string>();
  const visit = (moduleId: string): void => {
    if (reachable.has(moduleId)) {
      return;
    }
    const module = modules.get(moduleId);
    if (!module) {
      return;
    }
    reachable.add(moduleId);
    module.dependencies.forEach((dependency) =>
      visit(modulePathToString(dependency.path)),
    );
    inlineChildren.get(moduleId)?.forEach(visit);
  };

  visit(entry);
  return reachable;
};

export const buildModuleGraph = async ({
  entryPath,
  host,
  roots,
  includeTests,
}: BuildGraphOptions): Promise<ModuleGraph> => {
  const modules = new Map<string, ModuleNode>();
  const modulesByPath = new Map<string, ModuleNode>();
  const moduleDiagnostics: ModuleDiagnostic[] = [];
  const docDiagnostics: Diagnostic[] = [];
  const docDiagnosticKeys = new Set<string>();
  const missingModules = new Map<string, Set<string>>();
  const moduleNestedPrefixCounts = new Map<string, number>();
  const pendingNestedPrefixCounts = new Map<string, number>();
  const noPreludeByModule = new Map<string, boolean>();
  const inactiveModuleFiles = new Set<string>();
  const collectedUseEntries = new Map<string, Set<string>>();
  const inlineModuleAstKeys = new Map<string, string>();
  const macroExpander = createModuleMacroExpander();
  const macroDiagnosticsByModule = new Map<string, Diagnostic[]>();
  const surfaceDiagnosticsByModule = new Map<string, Diagnostic[]>();
  const isReplaceableSurfaceDiagnostic = (diagnostic: Diagnostic): boolean =>
    diagnostic.code === "MD0005";

  const useEntryKeys = (module: ModuleNode): Set<string> => {
    const items =
      module.surface?.items ??
      module.header?.items ??
      createModuleHeaderView(module.ast).items;
    return new Set(
      items.flatMap((item) =>
        item.kind === "use"
          ? item.entries.map((entry) =>
              JSON.stringify([
                item.visibility,
                entry.moduleSegments,
                entry.path,
                entry.targetName ?? null,
                entry.alias ?? null,
                entry.selectionKind,
                entry.anchorToSelf ?? false,
                entry.parentHops ?? 0,
                entry.hasExplicitPrefix,
              ]),
            )
          : [],
      ),
    );
  };

  const setsEqual = (left: ReadonlySet<string>, right: ReadonlySet<string>) =>
    left.size === right.size && Array.from(left).every((key) => right.has(key));

  const moduleAstKey = (module: ModuleNode): string =>
    JSON.stringify(module.ast.toJSON());

  const addDocDiagnostics = (diagnostics: readonly Diagnostic[]): void => {
    diagnostics.forEach((diagnostic) => {
      if (isReplaceableSurfaceDiagnostic(diagnostic)) {
        return;
      }
      const key = [
        diagnostic.code,
        diagnostic.message,
        diagnostic.span.file,
        diagnostic.span.start,
        diagnostic.span.end,
      ].join(":");
      if (docDiagnosticKeys.has(key)) {
        return;
      }
      docDiagnosticKeys.add(key);
      docDiagnostics.push(diagnostic);
    });
  };

  const inlineChildrenFor = (parentId: string): ModuleNode[] =>
    Array.from(modules.values()).filter(
      (module) =>
        module.origin.kind === "inline" && module.origin.parentId === parentId,
    );

  const removeInlineModuleTree = (moduleId: string): void => {
    const module = modules.get(moduleId);
    if (!module || module.origin.kind !== "inline") {
      return;
    }

    inlineChildrenFor(moduleId).forEach((child) =>
      removeInlineModuleTree(child.id),
    );
    macroExpander.reset(moduleId);
    macroDiagnosticsByModule.delete(moduleId);
    surfaceDiagnosticsByModule.delete(moduleId);
    missingModules.delete(moduleId);
    modules.delete(moduleId);
    modulesByPath.delete(modulePathToString(module.path));
    noPreludeByModule.delete(moduleId);
    collectedUseEntries.delete(moduleId);
    inlineModuleAstKeys.delete(moduleId);
    updateNestedPrefixCounts({
      counts: moduleNestedPrefixCounts,
      pathKey: modulePathToString(module.path),
      delta: -1,
    });
  };

  const removeInlineDescendants = (parentId: string): void =>
    inlineChildrenFor(parentId).forEach((child) =>
      removeInlineModuleTree(child.id),
    );

  const removeMissingInlineDescendants = ({
    parentId,
    retainedModuleIds,
  }: {
    parentId: string;
    retainedModuleIds: ReadonlySet<string>;
  }): void => {
    inlineChildrenFor(parentId).forEach((child) => {
      if (!retainedModuleIds.has(child.id)) {
        removeInlineModuleTree(child.id);
        return;
      }
      removeMissingInlineDescendants({
        parentId: child.id,
        retainedModuleIds,
      });
    });
  };

  const hasMissingModule = (importer: string, pathKey: string): boolean =>
    missingModules.get(importer)?.has(pathKey) ?? false;

  const addMissingModule = (importer: string, pathKey: string) => {
    const entries = missingModules.get(importer);
    if (entries) {
      entries.add(pathKey);
      return;
    }
    missingModules.set(importer, new Set([pathKey]));
  };

  const preludeStartedAt = COMPILER_PERF_ENABLED ? performance.now() : 0;
  const hasStdPreludeModule = await supportsStdPreludeAutoImport({
    roots,
    host,
  });
  recordCompilerPerfDuration({
    name: "graph.supports_std_prelude.ms",
    startedAt: preludeStartedAt,
  });

  const entryFile = host.path.resolve(entryPath);
  const entryModulePath = modulePathFromFile(entryFile, roots, host.path);
  const entryReservedSegment = findReservedModuleSegment(entryModulePath);
  if (entryReservedSegment) {
    moduleDiagnostics.push({
      kind: "reserved-module-segment",
      segment: entryReservedSegment,
      requested: entryModulePath,
      span: { file: entryFile, start: 0, end: 0 },
    });
  }
  const entryModule = await loadFileModule({
    filePath: entryFile,
    modulePath: entryModulePath,
    host,
    roots,
    includeTests: includeTests === true,
    hasStdPreludeModule,
  });

  addModuleTree(entryModule, modules, modulesByPath, (module) => {
    noPreludeByModule.set(module.id, entryModule.noPrelude);
    collectedUseEntries.set(module.id, useEntryKeys(module));
    if (module.origin.kind === "inline") {
      inlineModuleAstKeys.set(module.id, moduleAstKey(module));
    }
    updateNestedPrefixCounts({
      counts: moduleNestedPrefixCounts,
      pathKey: modulePathToString(module.path),
      delta: 1,
    });
  });
  addDocDiagnostics(entryModule.diagnostics);

  const pending: PendingDependency[] = [];
  enqueueDependencies(entryModule, pending, (queued) => {
    if (COMPILER_PERF_ENABLED) {
      incrementCompilerPerfCounter("graph.pending.enqueued");
    }
    updateNestedPrefixCounts({
      counts: pendingNestedPrefixCounts,
      pathKey: modulePathToString(queued.dependency.path),
      delta: 1,
    });
  });

  const hasNestedModule = (pathKey: string): boolean => {
    if (COMPILER_PERF_ENABLED) {
      incrementCompilerPerfCounter("graph.nested.checks");
    }
    const hasNested =
      (moduleNestedPrefixCounts.get(pathKey) ?? 0) > 0 ||
      (pendingNestedPrefixCounts.get(pathKey) ?? 0) > 0;
    if (hasNested && COMPILER_PERF_ENABLED) {
      incrementCompilerPerfCounter("graph.nested.hits");
    }
    return hasNested;
  };

  let pendingIndex = 0;
  while (true) {
    if (pendingIndex >= pending.length) {
      const expansion = macroExpander.expand({
        entry: entryModule.node.id,
        modules,
        diagnostics: [],
      });
      expansion.diagnosticsByModule.forEach((diagnostics, moduleId) =>
        macroDiagnosticsByModule.set(moduleId, diagnostics),
      );
      if (!expansion.expandedModuleIds.length) {
        break;
      }

      const refreshedModules = expansion.expandedModuleIds.flatMap(
        (moduleId) => {
          const module = modules.get(moduleId);
          if (!module) {
            return [];
          }
          return [
            {
              module,
              info: collectExpandedModuleInfo({
                module,
                host,
                hasStdPreludeModule,
                noPrelude: noPreludeByModule.get(module.id) ?? false,
              }),
            },
          ];
        },
      );
      refreshedModules.forEach(({ module, info: refreshed }) => {
        if (modules.get(module.id) !== module) {
          return;
        }
        const previousUseEntries =
          collectedUseEntries.get(module.id) ?? new Set<string>();
        const refreshedUseEntries = useEntryKeys(module);
        const useEntriesChanged = !setsEqual(
          previousUseEntries,
          refreshedUseEntries,
        );
        collectedUseEntries.set(module.id, refreshedUseEntries);
        surfaceDiagnosticsByModule.set(
          module.id,
          refreshed.diagnostics.filter(isReplaceableSurfaceDiagnostic),
        );
        const discoveredSubmodules = module.dependencies.filter(
          (dependency) => dependency.kind === "export",
        );
        module.dependencies = [
          ...refreshed.dependencies,
          ...discoveredSubmodules,
        ];
        if (useEntriesChanged) {
          macroExpander.invalidate(module.id);
        }

        removeMissingInlineDescendants({
          parentId: module.id,
          retainedModuleIds: new Set(
            refreshed.inlineModules.map((inlineModule) => inlineModule.id),
          ),
        });
        const changedInlineModules = refreshed.inlineModules.filter(
          (inlineModule) => {
            const existing = modules.get(inlineModule.id);
            return (
              !existing ||
              existing.origin.kind === "file" ||
              inlineModuleAstKeys.get(existing.id) !==
                moduleAstKey(inlineModule)
            );
          },
        );
        changedInlineModules.forEach((inlineModule) => {
          const existing = modules.get(inlineModule.id);
          if (existing?.origin.kind === "file") {
            removeInlineDescendants(existing.id);
          }
        });
        changedInlineModules.forEach((inlineModule) => {
          const existing = modules.get(inlineModule.id);
          if (existing) {
            macroExpander.reset(existing.id);
            macroDiagnosticsByModule.delete(existing.id);
            surfaceDiagnosticsByModule.delete(existing.id);
            missingModules.delete(existing.id);
          }
          if (existing?.origin.kind === "file") {
            (existing.sourceFiles ?? [
              { filePath: existing.origin.filePath, source: existing.source },
            ]).forEach(({ filePath }) => inactiveModuleFiles.add(filePath));
          }
          modules.set(inlineModule.id, inlineModule);
          modulesByPath.set(
            modulePathToString(inlineModule.path),
            inlineModule,
          );
          noPreludeByModule.set(
            inlineModule.id,
            noPreludeByModule.get(module.id) ?? false,
          );
          collectedUseEntries.set(inlineModule.id, useEntryKeys(inlineModule));
          inlineModuleAstKeys.set(inlineModule.id, moduleAstKey(inlineModule));
          if (!existing) {
            updateNestedPrefixCounts({
              counts: moduleNestedPrefixCounts,
              pathKey: modulePathToString(inlineModule.path),
              delta: 1,
            });
          }
        });

        enqueueDependencies(
          {
            node: module,
            inlineModules: changedInlineModules,
          },
          pending,
          (queued) => {
            if (COMPILER_PERF_ENABLED) {
              incrementCompilerPerfCounter("graph.pending.enqueued");
            }
            updateNestedPrefixCounts({
              counts: pendingNestedPrefixCounts,
              pathKey: modulePathToString(queued.dependency.path),
              delta: 1,
            });
          },
        );
      });
      continue;
    }

    const nextPending = pending[pendingIndex];
    pendingIndex += 1;
    if (!nextPending) {
      continue;
    }

    if (COMPILER_PERF_ENABLED) {
      incrementCompilerPerfCounter("graph.pending.dequeued");
    }
    const { dependency, importerId, importerFilePath } = nextPending;
    updateNestedPrefixCounts({
      counts: pendingNestedPrefixCounts,
      pathKey: modulePathToString(dependency.path),
      delta: -1,
    });

    const importerLabel = importerFilePath ?? importerId;
    const requestedPath = dependency.path;
    const requestedKey = modulePathToString(requestedPath);
    if (modulesByPath.has(requestedKey)) {
      continue;
    }
    if (hasMissingModule(importerId, requestedKey)) {
      continue;
    }

    let resolved: Awaited<ReturnType<typeof resolveModuleFile>>;
    try {
      resolved = await resolveModuleFile(requestedPath, roots, host);
    } catch (error) {
      moduleDiagnostics.push({
        kind: "io-error",
        message: formatErrorMessage(error),
        requested: requestedPath,
        importerId,
        importer: importerLabel,
        importerFilePath,
        span: dependency.span,
      });
      addMissingModule(importerId, requestedKey);
      continue;
    }

    if (!resolved) {
      moduleDiagnostics.push({
        kind: "missing-module",
        requested: requestedPath,
        importerId,
        importer: importerLabel,
        importerFilePath,
        span: dependency.span,
      });
      addMissingModule(importerId, requestedKey);
      continue;
    }

    const resolvedPath = resolved.filePath;
    const resolvedModulePath = resolved.modulePath;
    const resolvedKey = modulePathToString(resolvedModulePath);
    const resolvedExtendsRequested =
      resolvedModulePath.namespace === requestedPath.namespace &&
      resolvedModulePath.packageName === requestedPath.packageName &&
      resolvedModulePath.segments.length > requestedPath.segments.length &&
      requestedPath.segments.every(
        (segment, index) => resolvedModulePath.segments[index] === segment,
      );
    if (resolvedExtendsRequested) {
      dependency.path = resolvedModulePath;
    }
    const reservedSegment = findReservedModuleSegment(resolvedModulePath);
    if (reservedSegment) {
      moduleDiagnostics.push({
        kind: "reserved-module-segment",
        segment: reservedSegment,
        requested: resolvedModulePath,
        importerId,
        importer: importerLabel,
        importerFilePath,
        span: dependency.span ?? { file: resolvedPath, start: 0, end: 0 },
      });
      addMissingModule(importerId, requestedKey);
      continue;
    }
    if (modulesByPath.has(resolvedKey)) {
      if (hasNestedModule(requestedKey)) {
        continue;
      }
      moduleDiagnostics.push({
        kind: "missing-module",
        requested: requestedPath,
        importerId,
        importer: importerLabel,
        importerFilePath,
        span: dependency.span,
      });
      addMissingModule(importerId, requestedKey);
      continue;
    }
    let nextModule: LoadedModule;
    try {
      nextModule = await loadFileModule({
        filePath: resolvedPath,
        modulePath: resolvedModulePath,
        host,
        roots,
        includeTests: includeTests === true,
        hasStdPreludeModule,
      });
    } catch (error) {
      moduleDiagnostics.push({
        kind: "io-error",
        message: formatErrorMessage(error),
        requested: requestedPath,
        importerId,
        importer: importerLabel,
        importerFilePath,
        span: dependency.span,
      });
      addMissingModule(importerId, requestedKey);
      continue;
    }
    addModuleTree(nextModule, modules, modulesByPath, (module) => {
      noPreludeByModule.set(module.id, nextModule.noPrelude);
      collectedUseEntries.set(module.id, useEntryKeys(module));
      if (module.origin.kind === "inline") {
        inlineModuleAstKeys.set(module.id, moduleAstKey(module));
      }
      updateNestedPrefixCounts({
        counts: moduleNestedPrefixCounts,
        pathKey: modulePathToString(module.path),
        delta: 1,
      });
    });
    addDocDiagnostics(nextModule.diagnostics);
    enqueueDependencies(nextModule, pending, (queued) => {
      if (COMPILER_PERF_ENABLED) {
        incrementCompilerPerfCounter("graph.pending.enqueued");
      }
      updateNestedPrefixCounts({
        counts: pendingNestedPrefixCounts,
        pathKey: modulePathToString(queued.dependency.path),
        delta: 1,
      });
    });
    const dependencyKey = modulePathToString(dependency.path);
    if (!modulesByPath.has(dependencyKey) && !hasNestedModule(dependencyKey)) {
      moduleDiagnostics.push({
        kind: "missing-module",
        requested: requestedPath,
        importerId,
        importer: importerLabel,
        importerFilePath,
        span: dependency.span,
      });
      addMissingModule(importerId, requestedKey);
    }
  }

  const reachable = reachableModuleIds({
    entry: entryModule.node.id,
    modules,
  });
  modules.forEach((module, moduleId) => {
    if (reachable.has(moduleId)) {
      return;
    }
    module.sourceFiles?.forEach(({ filePath }) =>
      inactiveModuleFiles.add(filePath),
    );
    macroExpander.reset(moduleId);
    macroDiagnosticsByModule.delete(moduleId);
    surfaceDiagnosticsByModule.delete(moduleId);
    missingModules.delete(moduleId);
    modules.delete(moduleId);
    modulesByPath.delete(modulePathToString(module.path));
    noPreludeByModule.delete(moduleId);
    collectedUseEntries.delete(moduleId);
    inlineModuleAstKeys.delete(moduleId);
    updateNestedPrefixCounts({
      counts: moduleNestedPrefixCounts,
      pathKey: modulePathToString(module.path),
      delta: -1,
    });
  });

  const diagnosticIsStillRequested = (
    diagnostic: ModuleDiagnostic,
  ): boolean => {
    if (!diagnostic.importerId) {
      return true;
    }
    const importer = modules.get(diagnostic.importerId);
    if (!importer) {
      return false;
    }
    const requestedId = modulePathToString(diagnostic.requested);
    return importer.dependencies.some(
      (dependency) => modulePathToString(dependency.path) === requestedId,
    );
  };

  const unresolvedModuleDiagnostics = moduleDiagnostics.filter(
    (diagnostic) =>
      diagnosticIsStillRequested(diagnostic) &&
      !(
        diagnostic.importerFilePath &&
        inactiveModuleFiles.has(diagnostic.importerFilePath)
      ) &&
      (diagnostic.kind !== "missing-module" ||
        !hasAvailableModulePath({
          path: diagnostic.requested,
          modulesByPath,
          moduleNestedPrefixCounts,
        })),
  );
  const baseDiagnostics = unresolvedModuleDiagnostics.map(
    moduleDiagnosticToDiagnostic,
  );
  const macroDiagnostics = Array.from(
    macroDiagnosticsByModule.values(),
  ).flat();
  const surfaceDiagnostics = Array.from(
    surfaceDiagnosticsByModule.values(),
  ).flat();
  return {
    entry: entryModule.node.id,
    modules,
    diagnostics: [
      ...baseDiagnostics,
      ...docDiagnostics.filter(
        (diagnostic) => !inactiveModuleFiles.has(diagnostic.span.file),
      ),
      ...surfaceDiagnostics.filter(
        (diagnostic) => !inactiveModuleFiles.has(diagnostic.span.file),
      ),
      ...macroDiagnostics.filter(
        (diagnostic) => !inactiveModuleFiles.has(diagnostic.span.file),
      ),
    ],
  };
};

const addModuleTree = (
  root: LoadedModule,
  modules: Map<string, ModuleNode>,
  modulesByPath: Map<string, ModuleNode>,
  onModuleAdded?: (module: ModuleNode) => void,
) => {
  const allModules = [root.node, ...root.inlineModules];
  allModules.forEach((module) => {
    modules.set(module.id, module);
    modulesByPath.set(modulePathToString(module.path), module);
    onModuleAdded?.(module);
  });
};

const enqueueDependencies = (
  loaded: Pick<LoadedModule, "node" | "inlineModules">,
  queue: PendingDependency[],
  onQueued?: (queued: PendingDependency) => void,
) => {
  const modules = [loaded.node, ...loaded.inlineModules];
  const importerFilePathFor = (module: ModuleNode): string | undefined =>
    module.origin.kind === "file"
      ? module.origin.filePath
      : module.origin.span?.file;
  modules.forEach((module) =>
    module.dependencies.forEach((dependency) => {
      if (dependency.kind === "export" && !module.surface) {
        return;
      }
      const queued: PendingDependency = {
        dependency,
        importerId: module.id,
        importerFilePath: importerFilePathFor(module),
      };
      queue.push(queued);
      onQueued?.(queued);
    }),
  );
};

type LoadedModule = {
  node: ModuleNode;
  inlineModules: ModuleNode[];
  diagnostics: readonly Diagnostic[];
  noPrelude: boolean;
};

const parseModuleAst = ({
  source,
  filePath,
  modulePath,
}: {
  source: string;
  filePath: string;
  modulePath: ModulePath;
}): {
  ast: Form;
  diagnostics: readonly Diagnostic[];
} => {
  try {
    return { ast: parseBase(source, filePath), diagnostics: [] };
  } catch (error) {
    const parserLocation = parserErrorLocation(error);
    const span = parserLocation
      ? {
          file: parserLocation.filePath,
          start: parserLocation.startIndex,
          end: Math.max(parserLocation.startIndex + 1, parserLocation.endIndex),
        }
      : {
          file: filePath,
          start: 0,
          end: Math.max(1, source.length),
        };

    return {
      ast: parseBase("", filePath),
      diagnostics: [
        diagnosticFromCode({
          code: "MD0002",
          params: {
            kind: "load-failed",
            requested: modulePathToString(modulePath),
            errorMessage: `Failed to parse ${filePath}: ${formatErrorMessage(error)}`,
          },
          span,
        }),
      ],
    };
  }
};

const loadFileModule = async ({
  filePath,
  modulePath,
  host,
  roots,
  includeTests,
  hasStdPreludeModule,
}: {
  filePath: string;
  modulePath: ModulePath;
  host: ModuleHost;
  roots: ModuleRoots;
  includeTests: boolean;
  hasStdPreludeModule: boolean;
}): Promise<LoadedModule> => {
  const moduleStartedAt = COMPILER_PERF_ENABLED ? performance.now() : 0;
  incrementCompilerPerfCounter(
    `graph.load_module.${modulePath.namespace}.count`,
  );

  const readStartedAt = COMPILER_PERF_ENABLED ? performance.now() : 0;
  const source = await host.readFile(filePath);
  recordCompilerPerfDuration({
    name: `graph.read_file.${modulePath.namespace}.ms`,
    startedAt: readStartedAt,
  });

  const parseStartedAt = COMPILER_PERF_ENABLED ? performance.now() : 0;
  const primaryParsed = parseModuleDirectives(source);
  const primaryAst = parseModuleAst({
    source: primaryParsed.sanitizedSource,
    filePath,
    modulePath,
  });
  recordCompilerPerfDuration({
    name: `graph.parse.${modulePath.namespace}.ms`,
    startedAt: parseStartedAt,
  });

  let ast = primaryAst.ast;
  const parseDiagnostics: Diagnostic[] = [...primaryAst.diagnostics];
  let noPrelude = primaryParsed.noPrelude;
  const sourceByFile = new Map<string, string>([
    [filePath, primaryParsed.sanitizedSource],
  ]);

  if (includeTests && !isCompanionTestFile(filePath)) {
    const companionFilePath = companionFileFor(filePath);
    if (await host.fileExists(companionFilePath)) {
      const companionStartedAt = COMPILER_PERF_ENABLED ? performance.now() : 0;
      const companionSource = await host.readFile(companionFilePath);
      const companionParsed = parseModuleDirectives(companionSource);
      noPrelude = noPrelude || companionParsed.noPrelude;
      const companion = parseModuleAst({
        source: companionParsed.sanitizedSource,
        filePath: companionFilePath,
        modulePath,
      });
      parseDiagnostics.push(...companion.diagnostics);
      ast = mergeCompanionAst({ primary: ast, companion: companion.ast });
      sourceByFile.set(companionFilePath, companionParsed.sanitizedSource);
      recordCompilerPerfDuration({
        name: `graph.parse_companion.${modulePath.namespace}.ms`,
        startedAt: companionStartedAt,
      });
    }
  }

  ast = injectImplicitPreludeUse({
    ast,
    modulePath,
    hasStdPreludeModule,
    noPrelude,
  });
  const packageRootStartedAt = COMPILER_PERF_ENABLED ? performance.now() : 0;
  const sourcePackageRoot = await discoverSourcePackageRoot({
    modulePath,
    host,
    roots,
  });
  recordCompilerPerfDuration({
    name: `graph.discover_package_root.${modulePath.namespace}.ms`,
    startedAt: packageRootStartedAt,
  });

  const collectStartedAt = COMPILER_PERF_ENABLED ? performance.now() : 0;
  const info = collectModuleInfo({
    modulePath,
    ast,
    sourceByFile,
    sourcePackageRoot,
    moduleIsPackageRoot: host.path.basename(filePath, VOYD_EXTENSION) === "pkg",
    moduleRange: { start: 0, end: source.length },
    hasStdPreludeModule,
    noPrelude,
  });
  recordCompilerPerfDuration({
    name: `graph.collect_module_info.${modulePath.namespace}.ms`,
    startedAt: collectStartedAt,
  });

  const submodulesStartedAt = COMPILER_PERF_ENABLED ? performance.now() : 0;
  const submoduleDeps = await discoverSubmodules({
    filePath,
    modulePath,
    host,
  });
  recordCompilerPerfDuration({
    name: `graph.discover_submodules.${modulePath.namespace}.ms`,
    startedAt: submodulesStartedAt,
  });

  const node: ModuleNode = {
    id: modulePathToString(modulePath),
    path: modulePath,
    sourcePackageRoot,
    origin: { kind: "file", filePath },
    ast,
    header: createModuleHeaderView(ast),
    source,
    sourceFiles: sourceFilesFrom(sourceByFile),
    docs: info.docs,
    dependencies: [...info.dependencies, ...submoduleDeps],
  };

  recordCompilerPerfDuration({
    name: `graph.load_module.${modulePath.namespace}.ms`,
    startedAt: moduleStartedAt,
  });

  return {
    node,
    inlineModules: info.inlineModules,
    diagnostics: [...parseDiagnostics, ...info.diagnostics],
    noPrelude,
  };
};

type ModuleInfo = {
  dependencies: ModuleDependency[];
  inlineModules: ModuleNode[];
  docs: ModuleDocumentation;
  diagnostics: readonly Diagnostic[];
};

const VOYD_EXTENSION = ".voyd";
const TEST_COMPANION_EXTENSION = ".test.voyd";

const collectModuleInfo = ({
  modulePath,
  ast,
  sourceByFile,
  sourcePackageRoot,
  moduleIsPackageRoot,
  moduleRange,
  hasStdPreludeModule,
  noPrelude,
}: {
  modulePath: ModulePath;
  ast: Form;
  sourceByFile: ReadonlyMap<string, string>;
  sourcePackageRoot?: readonly string[];
  moduleIsPackageRoot: boolean;
  moduleRange: { start: number; end: number };
  hasStdPreludeModule: boolean;
  noPrelude: boolean;
}): ModuleInfo => {
  const dependencies: ModuleDependency[] = [];
  const inlineModules: ModuleNode[] = [];
  const diagnostics: Diagnostic[] = [];
  let needsStdPkg = false;
  const header = createModuleHeaderView(ast);
  const inlineModuleNames = new Set(
    header.items.flatMap((item) =>
      item.kind === "inline-module" ? [item.declaration.name] : [],
    ),
  );
  const sourceForDocs = sourceForModuleAst({ ast, sourceByFile });
  const collectedDocs = collectModuleDocumentation({
    ast,
    source: sourceForDocs,
    moduleRange,
  });
  diagnostics.push(...collectedDocs.diagnostics);

  header.items.forEach((item) => {
    const entry = item.form;
    const span = toSourceSpan(entry);

    if (item.kind === "use") {
      const resolvedEntries = item.entries
        .filter((entryPath) => entryPath.hasExplicitPrefix)
        .map((entryPath) => {
          const firstSegment = entryPath.moduleSegments[0];
          const preservesInlinePkgScope =
            moduleIsPackageRoot &&
            entryPath.anchorToSelf === true &&
            (entryPath.parentHops ?? 0) === 0 &&
            typeof firstSegment === "string" &&
            inlineModuleNames.has(firstSegment);

          return resolveModuleRequest(
            { segments: entryPath.moduleSegments, span: entryPath.span },
            modulePath,
            {
              anchorToSelf: entryPath.anchorToSelf === true,
              parentHops: entryPath.parentHops ?? 0,
              importerIsPackageRoot:
                moduleIsPackageRoot && !preservesInlinePkgScope,
            },
          );
        });
      resolvedEntries.forEach((path) => {
        if (!path.segments.length && !path.packageName) return;
        dependencies.push({
          kind: "use",
          path,
          span,
        });
        if (
          modulePath.namespace !== "std" &&
          path.namespace === "std" &&
          path.segments.length === 1 &&
          path.segments[0] === "pkg"
        ) {
          needsStdPkg = true;
        }
      });
      return;
    }

    if (item.kind !== "inline-module") {
      return;
    }
    const topLevelDecl = item.declaration;

    if (topLevelDecl.name === RESERVED_MODULE_SEGMENT) {
      const inlineModulePath = modulePathToString({
        ...modulePath,
        segments: [...modulePath.segments, topLevelDecl.name],
      });
      diagnostics.push(
        diagnosticFromCode({
          code: "MD0005",
          params: {
            kind: "reserved-module-segment",
            requested: inlineModulePath,
            segment: RESERVED_MODULE_SEGMENT,
          },
          span,
        }),
      );
      return;
    }

    const inline = parseInlineModuleDecl({
      decl: topLevelDecl,
      form: entry,
      parentPath: modulePath,
      sourceByFile,
      sourcePackageRoot,
      moduleIsPackageRoot: false,
      hasStdPreludeModule,
      noPrelude,
      outerModuleDoc: (() => {
        const first = entry.at(0);
        const visibilityOffset =
          isIdentifierAtom(first) && first.value === "pub" ? 1 : 0;
        const nameSyntax = entry.at(visibilityOffset + 1);
        return nameSyntax
          ? collectedDocs.documentation.declarationsBySyntaxId.get(
              nameSyntax.syntaxId,
            )
          : undefined;
      })(),
    });
    inlineModules.push(inline.node, ...inline.descendants);
    diagnostics.push(...inline.diagnostics);
  });

  if (needsStdPkg) {
    const already = dependencies.some(
      (dependency) =>
        dependency.path.namespace === "std" &&
        dependency.path.segments.length === 1 &&
        dependency.path.segments[0] === "pkg",
    );
    if (!already) {
      dependencies.push({
        kind: "use",
        path: { namespace: "std", segments: ["pkg"] },
      });
    }
  }

  return {
    dependencies,
    inlineModules,
    docs: collectedDocs.documentation,
    diagnostics,
  };
};

const collectExpandedModuleInfo = ({
  module,
  host,
  hasStdPreludeModule,
  noPrelude,
}: {
  module: ModuleNode;
  host: ModuleHost;
  hasStdPreludeModule: boolean;
  noPrelude: boolean;
}): ModuleInfo => {
  const sourceFiles = module.sourceFiles ?? [
    {
      filePath:
        module.origin.kind === "file"
          ? module.origin.filePath
          : (module.origin.span?.file ?? module.id),
      source: module.source,
    },
  ];
  const sourceByFile = new Map(
    sourceFiles.map(({ filePath, source }) => [filePath, source]),
  );

  return collectModuleInfo({
    modulePath: module.path,
    ast: module.ast,
    sourceByFile,
    sourcePackageRoot: module.sourcePackageRoot,
    moduleIsPackageRoot:
      module.origin.kind === "file" &&
      host.path.basename(module.origin.filePath, VOYD_EXTENSION) === "pkg",
    moduleRange: { start: 0, end: module.source.length },
    hasStdPreludeModule,
    noPrelude,
  });
};

type InlineModuleTree = {
  node: ModuleNode;
  descendants: ModuleNode[];
  diagnostics: readonly Diagnostic[];
};

const parseInlineModuleDecl = ({
  decl,
  form,
  parentPath,
  sourceByFile,
  sourcePackageRoot,
  moduleIsPackageRoot,
  hasStdPreludeModule,
  noPrelude,
  outerModuleDoc,
}: {
  decl: Extract<TopLevelDeclClassification, { kind: "inline-module-decl" }>;
  form: Form;
  parentPath: ModulePath;
  sourceByFile: ReadonlyMap<string, string>;
  sourcePackageRoot?: readonly string[];
  moduleIsPackageRoot: boolean;
  hasStdPreludeModule: boolean;
  noPrelude: boolean;
  outerModuleDoc?: string;
}): InlineModuleTree => {
  const modulePath = {
    ...parentPath,
    segments: [...parentPath.segments, decl.name],
  };

  const span = toSourceSpan(form);
  const sourceForModule =
    sourceByFile.get(span.file) ?? sourceByFile.values().next().value ?? "";
  const ast = injectImplicitPreludeUse({
    ast: toModuleAst(decl.body),
    modulePath,
    hasStdPreludeModule,
    noPrelude,
  });
  const moduleRangeStart = lineStartIndex(
    sourceForModule,
    (form.location?.startLine ?? decl.body.location?.startLine ?? 1) + 1,
  );
  const info = collectModuleInfo({
    modulePath,
    ast,
    sourceByFile,
    sourcePackageRoot,
    moduleRange: {
      start: moduleRangeStart,
      end: decl.body.location?.endIndex ?? sourceForModule.length,
    },
    moduleIsPackageRoot,
    hasStdPreludeModule,
    noPrelude,
  });

  const node: ModuleNode = {
    id: modulePathToString(modulePath),
    path: modulePath,
    sourcePackageRoot,
    origin: {
      kind: "inline",
      parentId: modulePathToString(parentPath),
      name: decl.name,
      span,
    },
    ast,
    header: createModuleHeaderView(ast),
    source: sliceSource(sourceForModule, span),
    sourceFiles: sourceFilesFrom(sourceByFile),
    docs: {
      ...info.docs,
      module: combineDocumentation(outerModuleDoc, info.docs.module),
    },
    dependencies: info.dependencies,
  };

  return {
    node,
    descendants: info.inlineModules,
    diagnostics: info.diagnostics,
  };
};

const toModuleAst = (block: Form): Form => {
  const body = block.rest;
  return new Form({
    elements: [new InternalIdentifierAtom("ast"), ...body],
    location: block.location,
  });
};

const sliceSource = (source: string, span: SourceSpan): string =>
  source.slice(span.start, span.end);

const sourceFilesFrom = (
  sourceByFile: ReadonlyMap<string, string>,
): readonly { filePath: string; source: string }[] =>
  Array.from(sourceByFile.entries())
    .map(([filePath, source]) => ({ filePath, source }))
    .sort((left, right) => left.filePath.localeCompare(right.filePath));

const sourceForModuleAst = ({
  ast,
  sourceByFile,
}: {
  ast: Form;
  sourceByFile: ReadonlyMap<string, string>;
}): string => {
  const filePath = ast.location?.filePath;
  if (filePath) {
    const source = sourceByFile.get(filePath);
    if (source !== undefined) {
      return source;
    }
  }

  return sourceByFile.values().next().value ?? "";
};

const lineStartIndex = (source: string, lineNumber: number): number => {
  if (lineNumber <= 1) {
    return 0;
  }

  let currentLine = 1;
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== "\n") {
      continue;
    }
    currentLine += 1;
    if (currentLine === lineNumber) {
      return index + 1;
    }
  }

  return source.length;
};

const isCompanionTestFile = (filePath: string): boolean =>
  filePath.endsWith(TEST_COMPANION_EXTENSION);

const companionFileFor = (filePath: string): string =>
  `${filePath.slice(0, -VOYD_EXTENSION.length)}${TEST_COMPANION_EXTENSION}`;

const mergeCompanionAst = ({
  primary,
  companion,
}: {
  primary: Form;
  companion: Form;
}): Form => {
  const primaryEntries = formCallsInternal(primary, "ast")
    ? primary.rest
    : primary.toArray();
  const companionEntries = formCallsInternal(companion, "ast")
    ? companion.rest
    : companion.toArray();
  const astHead = primary.first ?? new InternalIdentifierAtom("ast");

  return new Form({
    location: primary.location?.clone(),
    elements: [astHead, ...primaryEntries, ...companionEntries],
  }).toCall();
};

const parseModuleDirectives = (
  source: string,
): { sanitizedSource: string; noPrelude: boolean } => {
  let noPrelude = false;
  const sanitizedSource = source.replace(
    NO_PRELUDE_DIRECTIVE,
    (_full, prefix: string, directive: string) => {
      noPrelude = true;
      return `${prefix}${" ".repeat(directive.length)}`;
    },
  );

  return { sanitizedSource, noPrelude };
};

const hasExplicitPreludeUse = ({ ast }: { ast: Form }): boolean => {
  const hasPreludePrefix = (segments: readonly string[]): boolean =>
    segments.length >= PRELUDE_MODULE_SEGMENTS.length &&
    PRELUDE_MODULE_SEGMENTS.every(
      (segment, index) => segments[index] === segment,
    );

  return createModuleHeaderView(ast).items.some((item) => {
    if (item.kind !== "use") return false;
    return item.entries.some(
      (useEntry) =>
        hasPreludePrefix(useEntry.moduleSegments) ||
        hasPreludePrefix(useEntry.path),
    );
  });
};

const injectImplicitPreludeUse = ({
  ast,
  modulePath,
  hasStdPreludeModule,
  noPrelude,
}: {
  ast: Form;
  modulePath: ModulePath;
  hasStdPreludeModule: boolean;
  noPrelude: boolean;
}): Form => {
  if (modulePath.namespace === "std" || noPrelude || !hasStdPreludeModule) {
    return ast;
  }
  if (!formCallsInternal(ast, "ast")) {
    return ast;
  }
  if (hasExplicitPreludeUse({ ast })) {
    return ast;
  }

  const astHead = ast.first ?? new InternalIdentifierAtom("ast");
  return new Form({
    location: ast.location?.clone(),
    elements: [astHead, IMPLICIT_PRELUDE_USE_DECL.clone(), ...ast.rest],
  }).toCall();
};

const supportsStdPreludeAutoImport = async ({
  roots,
  host,
}: {
  roots: ModuleRoots;
  host: ModuleHost;
}): Promise<boolean> => {
  if (!roots.std) {
    return false;
  }

  const resolved = await resolveModuleFile(
    { namespace: "std", segments: ["prelude"] },
    roots,
    host,
  );
  return Boolean(resolved);
};

const discoverSubmodules = async ({
  filePath,
  modulePath,
  host,
}: {
  filePath: string;
  modulePath: ModulePath;
  host: ModuleHost;
}): Promise<ModuleDependency[]> => {
  const moduleDir = filePath.endsWith(VOYD_EXTENSION)
    ? filePath.slice(0, -VOYD_EXTENSION.length)
    : filePath;
  const isDir = await host.isDirectory(moduleDir);
  if (!isDir) return [];

  const dependencies: ModuleDependency[] = [];

  const walk = async (dir: string, segments: string[]): Promise<void> => {
    const entries = await host.readDir(dir);
    for (const entry of entries) {
      const entryIsDir = await host.isDirectory(entry);
      if (entryIsDir) {
        const name = host.path.basename(entry);
        await walk(entry, [...segments, name]);
        continue;
      }

      if (!entry.endsWith(VOYD_EXTENSION)) continue;
      if (entry.endsWith(TEST_COMPANION_EXTENSION)) continue;
      const stem = host.path.basename(entry, VOYD_EXTENSION);
      dependencies.push({
        kind: "export",
        path: {
          namespace: modulePath.namespace,
          packageName: modulePath.packageName,
          segments: [...modulePath.segments, ...segments, stem],
        },
      });
    }
  };

  await walk(moduleDir, []);
  return dependencies;
};

const discoverSourcePackageRoot = async ({
  modulePath,
  host,
  roots,
}: {
  modulePath: ModulePath;
  host: ModuleHost;
  roots: ModuleRoots;
}): Promise<readonly string[] | undefined> => {
  if (modulePath.namespace !== "src") {
    return undefined;
  }

  const sourceRoot = host.path.resolve(roots.src);
  for (
    let prefixLength = modulePath.segments.length - 1;
    prefixLength >= 0;
    prefixLength -= 1
  ) {
    const candidateSegments = [
      ...modulePath.segments.slice(0, prefixLength),
      "pkg",
    ];
    const candidateFile =
      host.path.join(sourceRoot, ...candidateSegments) + VOYD_EXTENSION;
    const exists = await host.fileExists(candidateFile);
    if (!exists) {
      continue;
    }
    return modulePath.segments.slice(0, prefixLength);
  }

  return undefined;
};
