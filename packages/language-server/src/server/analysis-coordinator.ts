import path from "node:path";
import { createFsModuleHost } from "@voyd/compiler/modules/fs-host.js";
import type { ModuleRoots } from "@voyd/compiler/modules/types.js";
import { type DidChangeWatchedFilesParams } from "vscode-languageserver/lib/node/main.js";
import { TextDocument } from "vscode-languageserver-textdocument";
import { URI } from "vscode-uri";
import {
  analyzeProjectCore,
  buildProjectNavigationIndex,
  resolveEntryPath,
  resolveModuleRoots,
} from "../project.js";
import { createOverlayModuleHost } from "../project/files.js";
import type {
  AutoImportAnalysis,
  ProjectCoreAnalysis,
  ProjectNavigationIndex,
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
};

type NavigationCacheEntry = {
  revision: number;
  index: ProjectNavigationIndex;
};

const normalizeFilePathFromUri = (uri: string): string =>
  path.resolve(URI.parse(uri).fsPath);

export class AnalysisCoordinator {
  readonly openDocuments = new Map<string, string>();
  readonly #fileSystemHost = createFsModuleHost();
  readonly #moduleHost = createOverlayModuleHost({
    openDocuments: this.openDocuments,
    fallbackHost: this.#fileSystemHost,
  });
  readonly #exportIndex: ExportIndexService;
  #revision = 0;
  readonly #coreCache = new Map<string, CoreCacheEntry>();
  readonly #coreInFlight = new Map<string, Promise<ProjectCoreAnalysis>>();
  readonly #navigationCache = new Map<string, NavigationCacheEntry>();
  readonly #navigationInFlight = new Map<string, Promise<ProjectNavigationIndex>>();

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
    this.#invalidate();
  }

  async removeDocument(document: TextDocument): Promise<void> {
    const filePath = normalizeFilePathFromUri(document.uri);
    this.openDocuments.delete(filePath);
    await this.#exportIndex.refreshFromDisk(filePath);
    this.#invalidate();
  }

  async handleWatchedFileChanges(
    changes: DidChangeWatchedFilesParams["changes"],
  ): Promise<boolean> {
    const updated = await this.#exportIndex.applyWatchedFileChanges({
      changes,
      openDocuments: this.openDocuments,
    });
    if (!updated) {
      return false;
    }

    this.#invalidate();
    return true;
  }

  async getCoreForUri(
    uri: string,
  ): Promise<{ context: UriContext; analysis: ProjectCoreAnalysis }> {
    const context = await this.#resolveUriContext(uri);
    const analysis = await this.#getCoreForContext(context);
    if (
      context.filePath === context.entryPath ||
      analysis.moduleIdByFilePath.has(context.filePath)
    ) {
      return { context, analysis };
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
    const fallbackAnalysis = await this.#getCoreForContext(fallbackContext);
    return {
      context: fallbackContext,
      analysis: fallbackAnalysis,
    };
  }

  async getNavigationForUri(uri: string): Promise<ProjectNavigationIndex> {
    const { context, analysis } = await this.getCoreForUri(uri);
    const cached = this.#navigationCache.get(context.cacheKey);
    if (cached && cached.revision === this.#revision) {
      return cached.index;
    }

    const runRevision = this.#revision;
    const inFlightKey = AnalysisCoordinator.#inFlightKey({
      contextKey: context.cacheKey,
      revision: runRevision,
    });
    const pending = this.#navigationInFlight.get(inFlightKey);
    if (pending) {
      const result = await pending;
      return runRevision === this.#revision ? result : this.getNavigationForUri(uri);
    }

    const task = (async () => {
      const index = await buildProjectNavigationIndex({ analysis });
      if (this.#revision === runRevision) {
        this.#navigationCache.set(context.cacheKey, {
          revision: runRevision,
          index,
        });
      }
      return index;
    })();

    this.#navigationInFlight.set(inFlightKey, task);

    try {
      const result = await task;
      return runRevision === this.#revision ? result : this.getNavigationForUri(uri);
    } finally {
      this.#navigationInFlight.delete(inFlightKey);
    }
  }

  async getAutoImportAnalysisForUri(uri: string): Promise<AutoImportAnalysis> {
    const { context, analysis } = await this.getCoreForUri(uri);
    const exportsByName = this.#exportIndex.buildAutoImportExports({
      roots: context.roots,
      semantics: analysis.semantics,
    });
    return {
      moduleIdByFilePath: analysis.moduleIdByFilePath,
      semantics: analysis.semantics,
      graph: analysis.graph,
      exportsByName,
    };
  }

  #invalidate(): void {
    this.#revision += 1;
    this.#coreCache.clear();
    this.#navigationCache.clear();
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

  async #getCoreForContext(context: UriContext): Promise<ProjectCoreAnalysis> {
    const cached = this.#coreCache.get(context.cacheKey);
    if (cached && cached.revision === this.#revision) {
      return cached.analysis;
    }

    const runRevision = this.#revision;
    const inFlightKey = AnalysisCoordinator.#inFlightKey({
      contextKey: context.cacheKey,
      revision: runRevision,
    });
    const pending = this.#coreInFlight.get(inFlightKey);
    if (pending) {
      const result = await pending;
      return runRevision === this.#revision ? result : this.#getCoreForContext(context);
    }

    const task = (async () => {
      await this.#exportIndex.ensureInitialized({
        roots: context.roots,
        openDocuments: this.openDocuments,
      });
      const analysis = await analyzeProjectCore({
        entryPath: context.entryPath,
        roots: context.roots,
        openDocuments: this.openDocuments,
        host: this.#moduleHost,
      });
      if (this.#revision === runRevision) {
        this.#coreCache.set(context.cacheKey, {
          revision: runRevision,
          analysis,
        });
      }
      return analysis;
    })();

    this.#coreInFlight.set(inFlightKey, task);

    try {
      const result = await task;
      return runRevision === this.#revision ? result : this.#getCoreForContext(context);
    } finally {
      this.#coreInFlight.delete(inFlightKey);
    }
  }
}
