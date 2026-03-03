import path from "node:path";
import { createFsModuleHost } from "@voyd/compiler/modules/fs-host.js";
import type { ModuleHost, ModuleRoots } from "@voyd/compiler/modules/types.js";
import { isSemanticsAnalysisCancelledError } from "@voyd/compiler/modules/semantic-analysis.js";
import { type DidChangeWatchedFilesParams } from "vscode-languageserver/lib/node/main.js";
import { TextDocument } from "vscode-languageserver-textdocument";
import { URI } from "vscode-uri";
import {
  analyzeProjectCoreIncremental,
  buildProjectNavigationIndex,
  buildProjectNavigationIndexForModules,
  isProjectAnalysisCancelledError,
  resolveEntryPath,
  resolveModuleRoots,
} from "../project.js";
import {
  buildCompletionExportEntriesByFirstCharacter,
  buildCompletionIndex,
  buildCompletionScopedNodesByModuleId,
  buildCompletionSymbolLookupByUri,
} from "../project/completion-index.js";
import { createOverlayModuleHost } from "../project/files.js";
import { smallestRangeFirst } from "../project/text.js";
import type {
  AutoImportAnalysis,
  CompletionAnalysis,
  CompletionSymbolLookup,
  ProjectCoreAnalysis,
  ProjectNavigationIndex,
  SymbolOccurrence,
} from "../project/types.js";
import { ExportIndexService } from "./export-index-service.js";

type UriContext = {
  filePath: string;
  entryPath: string;
  roots: ModuleRoots;
  cacheKey: string;
};

type CoreCacheEntry = {
  revision: number;
  analysis: ProjectCoreAnalysis;
  recomputedModuleIds: readonly string[];
};

type NavigationCacheEntry = {
  revision: number;
  index: ProjectNavigationIndex;
};

type CompletionCacheEntry = {
  revision: number;
  analysis: CompletionAnalysis;
};

const normalizeFilePathFromUri = (uri: string): string =>
  path.resolve(URI.parse(uri).fsPath);

const STALE_RUN_ERROR_CODE = "VOYD_LS_STALE_RUN";

const createStaleRunError = (): Error & { code: string } => {
  const error = new Error("stale language-server analysis run") as Error & {
    code: string;
  };
  error.name = "StaleAnalysisRunError";
  error.code = STALE_RUN_ERROR_CODE;
  return error;
};

const isStaleRunError = (error: unknown): error is Error & { code: string } =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { code?: unknown }).code === STALE_RUN_ERROR_CODE;

const isCancelledError = (error: unknown): boolean =>
  isStaleRunError(error) ||
  isProjectAnalysisCancelledError(error) ||
  isSemanticsAnalysisCancelledError(error);

const toImpactedModuleSet = (
  moduleIds: readonly string[],
): Set<string> => new Set(moduleIds);

const mergeOccurrencesByUri = ({
  base,
  delta,
  impactedModuleIds,
}: {
  base: ReadonlyMap<string, readonly SymbolOccurrence[]>;
  delta: ReadonlyMap<string, readonly SymbolOccurrence[]>;
  impactedModuleIds: ReadonlySet<string>;
}): Map<string, SymbolOccurrence[]> => {
  const merged = new Map<string, SymbolOccurrence[]>();

  base.forEach((entries, uri) => {
    const kept = entries.filter((entry) => !impactedModuleIds.has(entry.moduleId));
    if (kept.length > 0) {
      merged.set(uri, [...kept]);
    }
  });

  delta.forEach((entries, uri) => {
    const existing = merged.get(uri) ?? [];
    merged.set(uri, [...existing, ...entries].sort(smallestRangeFirst));
  });

  return merged;
};

const mergeDeclarationsByKey = ({
  base,
  delta,
  impactedModuleIds,
}: {
  base: ReadonlyMap<string, readonly SymbolOccurrence[]>;
  delta: ReadonlyMap<string, readonly SymbolOccurrence[]>;
  impactedModuleIds: ReadonlySet<string>;
}): Map<string, SymbolOccurrence[]> => {
  const merged = new Map<string, SymbolOccurrence[]>();

  base.forEach((entries, key) => {
    const kept = entries.filter((entry) => !impactedModuleIds.has(entry.moduleId));
    if (kept.length > 0) {
      merged.set(key, [...kept]);
    }
  });

  delta.forEach((entries, key) => {
    const existing = merged.get(key) ?? [];
    merged.set(key, [...existing, ...entries].sort(smallestRangeFirst));
  });

  return merged;
};

const mergeNavigationIndex = ({
  base,
  delta,
  impactedModuleIds,
}: {
  base: ProjectNavigationIndex;
  delta: ProjectNavigationIndex;
  impactedModuleIds: ReadonlySet<string>;
}): ProjectNavigationIndex => {
  const occurrencesByUri = mergeOccurrencesByUri({
    base: base.occurrencesByUri,
    delta: delta.occurrencesByUri,
    impactedModuleIds,
  });
  const declarationsByKey = mergeDeclarationsByKey({
    base: base.declarationsByKey,
    delta: delta.declarationsByKey,
    impactedModuleIds,
  });

  const affectedCanonicalKeys = new Set<string>();
  base.declarationsByKey.forEach((entries, key) => {
    if (entries.some((entry) => impactedModuleIds.has(entry.moduleId))) {
      affectedCanonicalKeys.add(key);
    }
  });
  delta.declarationsByKey.forEach((_entries, key) => affectedCanonicalKeys.add(key));

  const documentationByCanonicalKey = new Map(base.documentationByCanonicalKey);
  const typeInfoByCanonicalKey = new Map(base.typeInfoByCanonicalKey);
  affectedCanonicalKeys.forEach((key) => {
    documentationByCanonicalKey.delete(key);
    typeInfoByCanonicalKey.delete(key);
  });
  delta.documentationByCanonicalKey.forEach((value, key) =>
    documentationByCanonicalKey.set(key, value),
  );
  delta.typeInfoByCanonicalKey.forEach((value, key) =>
    typeInfoByCanonicalKey.set(key, value),
  );

  return {
    occurrencesByUri,
    declarationsByKey,
    documentationByCanonicalKey,
    typeInfoByCanonicalKey,
  };
};

const mergeScopedNodesByModuleId = ({
  base,
  delta,
  impactedModuleIds,
}: {
  base: CompletionAnalysis["completionIndex"]["scopedNodesByModuleId"];
  delta: CompletionAnalysis["completionIndex"]["scopedNodesByModuleId"];
  impactedModuleIds: ReadonlySet<string>;
}): CompletionAnalysis["completionIndex"]["scopedNodesByModuleId"] => {
  const merged = new Map(base);
  impactedModuleIds.forEach((moduleId) => merged.delete(moduleId));
  delta.forEach((value, moduleId) => merged.set(moduleId, value));
  return merged;
};

const mergeSymbolLookupByUri = ({
  base,
  delta,
  impactedModuleIds,
}: {
  base: CompletionAnalysis["completionIndex"]["symbolLookupByUri"];
  delta: CompletionAnalysis["completionIndex"]["symbolLookupByUri"];
  impactedModuleIds: ReadonlySet<string>;
}): Map<string, ReadonlyMap<string, CompletionSymbolLookup>> => {
  const merged = new Map<string, Map<string, CompletionSymbolLookup>>();

  base.forEach((byModuleId, uri) => {
    const keptByModuleId = new Map<string, CompletionSymbolLookup>();
    byModuleId.forEach((lookup, moduleId) => {
      if (impactedModuleIds.has(moduleId)) {
        return;
      }
      keptByModuleId.set(moduleId, lookup);
    });
    if (keptByModuleId.size > 0) {
      merged.set(uri, keptByModuleId);
    }
  });

  delta.forEach((byModuleId, uri) => {
    const existingByModuleId = merged.get(uri) ?? new Map<string, CompletionSymbolLookup>();
    byModuleId.forEach((lookup, moduleId) => {
      existingByModuleId.set(moduleId, lookup);
    });
    if (existingByModuleId.size > 0) {
      merged.set(uri, existingByModuleId);
    }
  });

  return merged;
};

export class AnalysisCoordinator {
  readonly openDocuments = new Map<string, string>();
  readonly #fileSystemHost = createFsModuleHost();
  readonly #moduleHost = createOverlayModuleHost({
    openDocuments: this.openDocuments,
    fallbackHost: this.#fileSystemHost,
  });
  readonly #exportIndex: ExportIndexService;
  #revision = 0;
  readonly #changedFilesByRevision = new Map<number, ReadonlySet<string>>();
  readonly #coreCache = new Map<string, CoreCacheEntry>();
  readonly #coreInFlight = new Map<string, Promise<CoreCacheEntry>>();
  readonly #navigationCache = new Map<string, NavigationCacheEntry>();
  readonly #navigationInFlight = new Map<string, Promise<ProjectNavigationIndex>>();
  readonly #completionCache = new Map<string, CompletionCacheEntry>();
  readonly #completionInFlight = new Map<string, Promise<CompletionAnalysis>>();

  constructor({
    exportIndex = new ExportIndexService(),
  }: {
    exportIndex?: ExportIndexService;
  } = {}) {
    this.#exportIndex = exportIndex;
  }

  updateDocument(document: TextDocument): void {
    const filePath = normalizeFilePathFromUri(document.uri);
    const source = document.getText();
    this.openDocuments.set(filePath, source);
    this.#exportIndex.updateOpenDocument({
      filePath,
      source,
    });
    this.#registerFileChanges([filePath]);
  }

  async removeDocument(document: TextDocument): Promise<void> {
    const filePath = normalizeFilePathFromUri(document.uri);
    this.openDocuments.delete(filePath);
    await this.#exportIndex.refreshFromDisk(filePath);
    this.#registerFileChanges([filePath]);
  }

  async handleWatchedFileChanges(
    changes: DidChangeWatchedFilesParams["changes"],
  ): Promise<boolean> {
    const voydFilePaths = changes
      .map((change) => normalizeFilePathFromUri(change.uri))
      .filter((filePath) => filePath.endsWith(".voyd"));
    if (voydFilePaths.length === 0) {
      return false;
    }

    const updated = await this.#exportIndex.applyWatchedFileChanges({
      changes,
      openDocuments: this.openDocuments,
    });
    if (!updated) {
      return false;
    }

    this.#registerFileChanges(voydFilePaths);
    return true;
  }

  async getCoreForUri(
    uri: string,
  ): Promise<{ context: UriContext; analysis: ProjectCoreAnalysis }> {
    const { context, entry } = await this.#getCoreEntryForUri(uri);
    return {
      context,
      analysis: entry.analysis,
    };
  }

  async getNavigationForUri(uri: string): Promise<ProjectNavigationIndex> {
    while (true) {
      const { context, entry } = await this.#getCoreEntryForUri(uri);
      const runRevision = entry.revision;
      let index: ProjectNavigationIndex;
      try {
        index = await this.#getNavigationForContext({
          context,
          coreEntry: entry,
        });
      } catch (error) {
        if (isCancelledError(error)) {
          continue;
        }
        throw error;
      }

      if (runRevision === this.#revision) {
        return index;
      }
    }
  }

  async getAutoImportAnalysisForUri(uri: string): Promise<AutoImportAnalysis> {
    const { context, entry } = await this.#getCoreEntryForUri(uri);
    const exportsByName = this.#exportIndex.buildAutoImportExports({
      roots: context.roots,
      semantics: entry.analysis.semantics,
    });
    return {
      moduleIdByFilePath: entry.analysis.moduleIdByFilePath,
      semantics: entry.analysis.semantics,
      graph: entry.analysis.graph,
      exportsByName,
    };
  }

  async getCompletionAnalysisForUri(uri: string): Promise<CompletionAnalysis> {
    while (true) {
      const { context, entry } = await this.#getCoreEntryForUri(uri);
      const runRevision = entry.revision;
      const cached = this.#completionCache.get(context.cacheKey);
      if (cached && cached.revision === runRevision) {
        return cached.analysis;
      }

      const inFlightKey = AnalysisCoordinator.#inFlightKey({
        contextKey: context.cacheKey,
        revision: runRevision,
      });
      const pending = this.#completionInFlight.get(inFlightKey);
      if (pending) {
        let result: CompletionAnalysis;
        try {
          result = await pending;
        } catch (error) {
          if (isCancelledError(error)) {
            continue;
          }
          throw error;
        }
        if (runRevision === this.#revision) {
          return result;
        }
        continue;
      }

      const task = (async () => {
        const analysis = entry.analysis;
        const navigation = await this.#getNavigationForContext({
          context,
          coreEntry: entry,
        });
        const impactedModuleIds = toImpactedModuleSet(entry.recomputedModuleIds);
        const exportsByName = this.#exportIndex.buildAutoImportExports({
          roots: context.roots,
          semantics: analysis.semantics,
        });
        const previousEntry = this.#completionCache.get(context.cacheKey);
        const needsFullRebuild =
          !previousEntry ||
          impactedModuleIds.size === analysis.semantics.size;

        const completionIndex = needsFullRebuild
          ? buildCompletionIndex({
              semantics: analysis.semantics,
              occurrencesByUri: navigation.occurrencesByUri,
              lineIndexByFile: analysis.lineIndexByFile,
              exportsByName,
              isCancelled: () => this.#isRunStale(runRevision),
            })
          : impactedModuleIds.size === 0
            ? {
                ...previousEntry.analysis.completionIndex,
                exportEntriesByFirstCharacter:
                  buildCompletionExportEntriesByFirstCharacter({
                    exportsByName,
                  }),
              }
            : {
                scopedNodesByModuleId: mergeScopedNodesByModuleId({
                  base: previousEntry.analysis.completionIndex.scopedNodesByModuleId,
                  delta: buildCompletionScopedNodesByModuleId({
                    semantics: analysis.semantics,
                    moduleIds: impactedModuleIds,
                    isCancelled: () => this.#isRunStale(runRevision),
                  }),
                  impactedModuleIds,
                }),
                symbolLookupByUri: mergeSymbolLookupByUri({
                  base: previousEntry.analysis.completionIndex.symbolLookupByUri,
                  delta: buildCompletionSymbolLookupByUri({
                    occurrencesByUri: navigation.occurrencesByUri,
                    lineIndexByFile: analysis.lineIndexByFile,
                    moduleIds: impactedModuleIds,
                    isCancelled: () => this.#isRunStale(runRevision),
                  }),
                  impactedModuleIds,
                }),
                exportEntriesByFirstCharacter:
                  buildCompletionExportEntriesByFirstCharacter({
                    exportsByName,
                  }),
              };

        const completionAnalysis: CompletionAnalysis = {
          occurrencesByUri: navigation.occurrencesByUri,
          declarationsByKey: navigation.declarationsByKey,
          documentationByCanonicalKey: navigation.documentationByCanonicalKey,
          typeInfoByCanonicalKey: navigation.typeInfoByCanonicalKey,
          moduleIdByFilePath: analysis.moduleIdByFilePath,
          semantics: analysis.semantics,
          graph: analysis.graph,
          sourceByFile: analysis.sourceByFile,
          lineIndexByFile: analysis.lineIndexByFile,
          exportsByName,
          completionIndex,
        };

        if (this.#revision === runRevision) {
          this.#completionCache.set(context.cacheKey, {
            revision: runRevision,
            analysis: completionAnalysis,
          });
        }
        return completionAnalysis;
      })();

      this.#completionInFlight.set(inFlightKey, task);

      try {
        const result = await task;
        if (runRevision === this.#revision) {
          return result;
        }
        continue;
      } catch (error) {
        if (isCancelledError(error)) {
          continue;
        }
        throw error;
      } finally {
        this.#completionInFlight.delete(inFlightKey);
      }
    }
  }

  static #inFlightKey({
    contextKey,
    revision,
  }: {
    contextKey: string;
    revision: number;
  }): string {
    return `${contextKey}@${revision}`;
  }

  static #contextCacheKey({
    entryPath,
    roots,
  }: {
    entryPath: string;
    roots: ModuleRoots;
  }): string {
    const src = path.resolve(roots.src);
    const std = roots.std ? path.resolve(roots.std) : "";
    const pkg = roots.pkg ? path.resolve(roots.pkg) : "";
    const pkgDirs = [...(roots.pkgDirs ?? [])]
      .map((pkgDir) => path.resolve(pkgDir))
      .sort();
    const hasResolvePackageRoot = roots.resolvePackageRoot ? "custom-pkg-resolver" : "";
    return [
      path.resolve(entryPath),
      src,
      std,
      pkg,
      hasResolvePackageRoot,
      ...pkgDirs,
    ].join("|");
  }

  async #getCoreEntryForUri(
    uri: string,
  ): Promise<{ context: UriContext; entry: CoreCacheEntry }> {
    const context = await this.#resolveUriContext(uri);
    const entry = await this.#getCoreForContext(context);
    if (
      context.filePath === context.entryPath ||
      entry.analysis.moduleIdByFilePath.has(context.filePath)
    ) {
      return { context, entry };
    }

    const fallbackContext: UriContext = {
      filePath: context.filePath,
      entryPath: context.filePath,
      roots: context.roots,
      cacheKey: AnalysisCoordinator.#contextCacheKey({
        entryPath: context.filePath,
        roots: context.roots,
      }),
    };
    const fallbackEntry = await this.#getCoreForContext(fallbackContext);
    return {
      context: fallbackContext,
      entry: fallbackEntry,
    };
  }

  async #resolveUriContext(uri: string): Promise<UriContext> {
    const filePath = normalizeFilePathFromUri(uri);
    const projectEntryPath = await resolveEntryPath(filePath);
    const roots = resolveModuleRoots(projectEntryPath);
    const cacheKey = AnalysisCoordinator.#contextCacheKey({
      entryPath: projectEntryPath,
      roots,
    });
    return {
      filePath,
      entryPath: projectEntryPath,
      roots,
      cacheKey,
    };
  }

  #isRunStale(revision: number): boolean {
    return this.#revision !== revision;
  }

  #throwIfRunStale(revision: number): void {
    if (!this.#isRunStale(revision)) {
      return;
    }

    throw createStaleRunError();
  }

  #createCancellableModuleHost(revision: number): ModuleHost {
    const baseHost = this.#moduleHost;

    return {
      path: baseHost.path,
      readFile: async (filePath) => {
        this.#throwIfRunStale(revision);
        const source = await baseHost.readFile(filePath);
        this.#throwIfRunStale(revision);
        return source;
      },
      readDir: async (directoryPath) => {
        this.#throwIfRunStale(revision);
        const entries = await baseHost.readDir(directoryPath);
        this.#throwIfRunStale(revision);
        return entries;
      },
      fileExists: async (filePath) => {
        this.#throwIfRunStale(revision);
        const exists = await baseHost.fileExists(filePath);
        this.#throwIfRunStale(revision);
        return exists;
      },
      isDirectory: async (directoryPath) => {
        this.#throwIfRunStale(revision);
        const isDirectory = await baseHost.isDirectory(directoryPath);
        this.#throwIfRunStale(revision);
        return isDirectory;
      },
    };
  }

  #registerFileChanges(filePaths: readonly string[]): void {
    const normalized = Array.from(
      new Set(
        filePaths
          .map((filePath) => path.resolve(filePath))
          .filter((filePath) => filePath.endsWith(".voyd")),
      ),
    );
    if (normalized.length === 0) {
      return;
    }

    this.#revision += 1;
    this.#changedFilesByRevision.set(this.#revision, new Set(normalized));
  }

  #changedFilesSince(revision: number): Set<string> {
    const changed = new Set<string>();
    for (let nextRevision = revision + 1; nextRevision <= this.#revision; nextRevision += 1) {
      const files = this.#changedFilesByRevision.get(nextRevision);
      if (!files) {
        continue;
      }
      files.forEach((filePath) => changed.add(filePath));
    }
    return changed;
  }

  #pruneChangedFileHistory(): void {
    if (this.#coreCache.size === 0) {
      this.#changedFilesByRevision.clear();
      return;
    }

    const minCachedRevision = Math.min(
      ...Array.from(this.#coreCache.values()).map((entry) => entry.revision),
    );
    Array.from(this.#changedFilesByRevision.keys()).forEach((revision) => {
      if (revision <= minCachedRevision) {
        this.#changedFilesByRevision.delete(revision);
      }
    });
  }

  async #getCoreForContext(context: UriContext): Promise<CoreCacheEntry> {
    const cached = this.#coreCache.get(context.cacheKey);
    if (cached && cached.revision === this.#revision) {
      return cached;
    }

    const runRevision = this.#revision;
    const inFlightKey = AnalysisCoordinator.#inFlightKey({
      contextKey: context.cacheKey,
      revision: runRevision,
    });
    const pending = this.#coreInFlight.get(inFlightKey);
    if (pending) {
      let result: CoreCacheEntry;
      try {
        result = await pending;
      } catch (error) {
        if (isCancelledError(error)) {
          return this.#getCoreForContext(context);
        }
        throw error;
      }
      return runRevision === this.#revision ? result : this.#getCoreForContext(context);
    }

    const task = (async () => {
      await this.#exportIndex.ensureInitialized({
        roots: context.roots,
        openDocuments: this.openDocuments,
      });

      const incremental = await analyzeProjectCoreIncremental({
        entryPath: context.entryPath,
        roots: context.roots,
        openDocuments: this.openDocuments,
        host: this.#createCancellableModuleHost(runRevision),
        previousAnalysis: cached?.analysis,
        changedFilePaths: this.#changedFilesSince(cached?.revision ?? -1),
        isCancelled: () => this.#isRunStale(runRevision),
      });
      const nextEntry: CoreCacheEntry = {
        revision: runRevision,
        analysis: incremental.analysis,
        recomputedModuleIds: incremental.recomputedModuleIds,
      };

      if (this.#revision === runRevision) {
        this.#coreCache.set(context.cacheKey, nextEntry);
        this.#pruneChangedFileHistory();
      }
      return nextEntry;
    })();

    this.#coreInFlight.set(inFlightKey, task);

    try {
      const result = await task;
      return runRevision === this.#revision ? result : this.#getCoreForContext(context);
    } catch (error) {
      if (isCancelledError(error)) {
        return this.#getCoreForContext(context);
      }
      throw error;
    } finally {
      this.#coreInFlight.delete(inFlightKey);
    }
  }

  async #getNavigationForContext({
    context,
    coreEntry,
  }: {
    context: UriContext;
    coreEntry: CoreCacheEntry;
  }): Promise<ProjectNavigationIndex> {
    const revision = coreEntry.revision;
    const cached = this.#navigationCache.get(context.cacheKey);
    if (cached && cached.revision === revision) {
      return cached.index;
    }

    const inFlightKey = AnalysisCoordinator.#inFlightKey({
      contextKey: context.cacheKey,
      revision,
    });
    const pending = this.#navigationInFlight.get(inFlightKey);
    if (pending) {
      return pending;
    }

    const task = (async () => {
      const impactedModuleIds = toImpactedModuleSet(coreEntry.recomputedModuleIds);
      const previousEntry = this.#navigationCache.get(context.cacheKey);
      const needsFullRebuild =
        !previousEntry ||
        impactedModuleIds.size === coreEntry.analysis.semantics.size;

      const index = needsFullRebuild
        ? await buildProjectNavigationIndex({
            analysis: coreEntry.analysis,
            isCancelled: () => this.#isRunStale(revision),
          })
        : impactedModuleIds.size === 0
          ? previousEntry.index
          : mergeNavigationIndex({
              base: previousEntry.index,
              delta: await buildProjectNavigationIndexForModules({
                analysis: coreEntry.analysis,
                moduleIds: impactedModuleIds,
                isCancelled: () => this.#isRunStale(revision),
              }),
              impactedModuleIds,
            });

      if (this.#revision === revision) {
        this.#navigationCache.set(context.cacheKey, {
          revision,
          index,
        });
      }
      return index;
    })();

    this.#navigationInFlight.set(inFlightKey, task);

    try {
      return await task;
    } finally {
      this.#navigationInFlight.delete(inFlightKey);
    }
  }
}
