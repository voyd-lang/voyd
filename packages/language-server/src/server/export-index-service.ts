import path from "node:path";
import type { ModuleRoots } from "@voyd/compiler/modules/types.js";
import type { SemanticsPipelineResult } from "@voyd/compiler/semantics/pipeline.js";
import { FileChangeType, type DidChangeWatchedFilesParams } from "vscode-languageserver/lib/node/main.js";
import { URI } from "vscode-uri";
import {
  IncrementalExportIndex,
  buildSemanticsExportIndex,
  mergeExportIndexes,
} from "../project/exports-index.js";
import type { ExportCandidate } from "../project/types.js";

const normalizeFilePathFromUri = (uri: string): string =>
  path.resolve(URI.parse(uri).fsPath);

export class ExportIndexService {
  readonly #index = new IncrementalExportIndex();

  async ensureInitialized({
    roots,
    openDocuments,
  }: {
    roots: ModuleRoots;
    openDocuments: ReadonlyMap<string, string>;
  }): Promise<void> {
    await this.#index.ensureInitialized({
      roots,
      openDocuments,
    });
  }

  updateOpenDocument({
    filePath,
    source,
  }: {
    filePath: string;
    source: string;
  }): void {
    this.#index.updateOpenDocument({
      filePath: path.resolve(filePath),
      source,
    });
  }

  async refreshFromDisk(filePath: string): Promise<void> {
    await this.#index.refreshFromDisk(path.resolve(filePath));
  }

  deleteFile(filePath: string): void {
    this.#index.deleteFile(path.resolve(filePath));
  }

  async applyWatchedFileChanges({
    changes,
    openDocuments,
  }: {
    changes: DidChangeWatchedFilesParams["changes"];
    openDocuments: ReadonlyMap<string, string>;
  }): Promise<boolean> {
    const voydChanges = changes
      .map((change) => ({
        filePath: normalizeFilePathFromUri(change.uri),
        type: change.type,
      }))
      .filter(({ filePath }) => filePath.endsWith(".voyd"));

    if (voydChanges.length === 0) {
      return false;
    }

    await Promise.all(
      voydChanges.map(async ({ filePath, type }) => {
        if (type === FileChangeType.Deleted) {
          this.deleteFile(filePath);
          return;
        }

        const openSource = openDocuments.get(filePath);
        if (openSource !== undefined) {
          this.updateOpenDocument({
            filePath,
            source: openSource,
          });
          return;
        }

        await this.refreshFromDisk(filePath);
      }),
    );

    return true;
  }

  buildAutoImportExports({
    roots,
    semantics,
  }: {
    roots: ModuleRoots;
    semantics: ReadonlyMap<string, SemanticsPipelineResult>;
  }): ReadonlyMap<string, readonly ExportCandidate[]> {
    const semanticExports = buildSemanticsExportIndex({
      semantics,
    });
    const workspaceExports = this.#index.exportsForRoots(roots);
    return mergeExportIndexes({
      primary: semanticExports,
      secondary: workspaceExports,
    });
  }
}
