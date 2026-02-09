import path from "node:path";
import { createFsModuleHost } from "@voyd/compiler/modules/fs-host.js";
import type { ModuleRoots } from "@voyd/compiler/modules/types.js";
import {
  createConnection,
  FileChangeType,
  ProposedFeatures,
  TextDocuments,
  TextDocumentSyncKind,
  type CodeActionParams,
  type DefinitionParams,
  type DidChangeWatchedFilesParams,
  type InitializeParams,
  type InitializeResult,
  type PrepareRenameParams,
  type RenameParams,
} from "vscode-languageserver/lib/node/main.js";
import { TextDocument } from "vscode-languageserver-textdocument";
import { URI } from "vscode-uri";
import {
  analyzeProjectCore,
  autoImportActions,
  buildProjectNavigationIndex,
  definitionsAtPosition,
  prepareRenameAtPosition,
  renameAtPosition,
  resolveEntryPath,
  resolveModuleRoots,
  type ProjectCoreAnalysis,
  type ProjectNavigationIndex,
} from "./project.js";
import { createOverlayModuleHost } from "./project/files.js";
import {
  IncrementalExportIndex,
  buildSemanticsExportIndex,
  mergeExportIndexes,
} from "./project/exports-index.js";

export type StartServerOptions = {
  connection?: ReturnType<typeof createConnection>;
};

type ResolvedUriContext = {
  filePath: string;
  entryPath: string;
  roots: ModuleRoots;
};

type CoreCacheEntry = {
  revision: number;
  analysis: ProjectCoreAnalysis;
};

type NavigationCacheEntry = {
  revision: number;
  index: ProjectNavigationIndex;
};

class ServerState {
  readonly documents = new TextDocuments(TextDocument);
  readonly openDocuments = new Map<string, string>();
  private revision = 0;
  private readonly fileSystemHost = createFsModuleHost();
  private readonly moduleHost = createOverlayModuleHost({
    openDocuments: this.openDocuments,
    fallbackHost: this.fileSystemHost,
  });
  private readonly exportIndex = new IncrementalExportIndex();
  private readonly coreCache = new Map<string, CoreCacheEntry>();
  private readonly coreInFlight = new Map<string, Promise<ProjectCoreAnalysis>>();
  private readonly navigationCache = new Map<string, NavigationCacheEntry>();
  private readonly navigationInFlight = new Map<string, Promise<ProjectNavigationIndex>>();

  private invalidateAnalysisCaches(): void {
    this.revision += 1;
    this.coreCache.clear();
    this.navigationCache.clear();
  }

  updateDocument(document: TextDocument): void {
    const filePath = path.resolve(URI.parse(document.uri).fsPath);
    const source = document.getText();
    this.openDocuments.set(filePath, source);
    this.exportIndex.updateOpenDocument({
      filePath,
      source,
    });
    this.invalidateAnalysisCaches();
  }

  async removeDocument(document: TextDocument): Promise<void> {
    const filePath = path.resolve(URI.parse(document.uri).fsPath);
    this.openDocuments.delete(filePath);
    await this.exportIndex.refreshFromDisk(filePath);
    this.invalidateAnalysisCaches();
  }

  async handleWatchedFileChanges(changes: DidChangeWatchedFilesParams["changes"]): Promise<void> {
    const voydChanges = changes
      .map((change) => ({
        filePath: path.resolve(URI.parse(change.uri).fsPath),
        type: change.type,
      }))
      .filter(({ filePath }) => filePath.endsWith(".voyd"));

    if (voydChanges.length === 0) {
      return;
    }

    await Promise.all(
      voydChanges.map(async ({ filePath, type }) => {
        if (type === FileChangeType.Deleted) {
          this.exportIndex.deleteFile(filePath);
          return;
        }

        const openSource = this.openDocuments.get(filePath);
        if (openSource !== undefined) {
          this.exportIndex.updateOpenDocument({
            filePath,
            source: openSource,
          });
          return;
        }

        await this.exportIndex.refreshFromDisk(filePath);
      }),
    );

    this.invalidateAnalysisCaches();
  }

  private static inFlightKey({
    entryPath,
    revision,
  }: {
    entryPath: string;
    revision: number;
  }): string {
    return `${entryPath}@${revision}`;
  }

  private async resolveUriContext(uri: string): Promise<ResolvedUriContext> {
    const filePath = path.resolve(URI.parse(uri).fsPath);
    const entryPath = await resolveEntryPath(filePath);
    const roots = resolveModuleRoots(entryPath);
    return { filePath, entryPath, roots };
  }

  private async getCoreForContext(context: ResolvedUriContext): Promise<ProjectCoreAnalysis> {
    const cached = this.coreCache.get(context.entryPath);
    if (cached && cached.revision === this.revision) {
      return cached.analysis;
    }

    const runRevision = this.revision;
    const inFlightKey = ServerState.inFlightKey({
      entryPath: context.entryPath,
      revision: runRevision,
    });
    const pending = this.coreInFlight.get(inFlightKey);
    if (pending) {
      const result = await pending;
      if (runRevision !== this.revision) {
        return this.getCoreForContext(context);
      }
      return result;
    }

    const task = (async () => {
      await this.exportIndex.ensureInitialized({
        roots: context.roots,
        openDocuments: this.openDocuments,
      });
      const analysis = await analyzeProjectCore({
        entryPath: context.entryPath,
        roots: context.roots,
        openDocuments: this.openDocuments,
        host: this.moduleHost,
      });
      if (this.revision === runRevision) {
        this.coreCache.set(context.entryPath, {
          revision: runRevision,
          analysis,
        });
      }
      return analysis;
    })();

    this.coreInFlight.set(inFlightKey, task);

    try {
      const result = await task;
      if (runRevision !== this.revision) {
        return this.getCoreForContext(context);
      }
      return result;
    } finally {
      this.coreInFlight.delete(inFlightKey);
    }
  }

  async getCoreForUri(
    uri: string,
  ): Promise<{ context: ResolvedUriContext; analysis: ProjectCoreAnalysis }> {
    const context = await this.resolveUriContext(uri);
    const analysis = await this.getCoreForContext(context);
    return { context, analysis };
  }

  async getNavigationForUri(uri: string): Promise<ProjectNavigationIndex> {
    const { context, analysis } = await this.getCoreForUri(uri);
    const cached = this.navigationCache.get(context.entryPath);
    if (cached && cached.revision === this.revision) {
      return cached.index;
    }

    const runRevision = this.revision;
    const inFlightKey = ServerState.inFlightKey({
      entryPath: context.entryPath,
      revision: runRevision,
    });
    const pending = this.navigationInFlight.get(inFlightKey);
    if (pending) {
      const result = await pending;
      if (runRevision !== this.revision) {
        return this.getNavigationForUri(uri);
      }
      return result;
    }

    const task = (async () => {
      const index = await buildProjectNavigationIndex({ analysis });
      if (this.revision === runRevision) {
        this.navigationCache.set(context.entryPath, {
          revision: runRevision,
          index,
        });
      }
      return index;
    })();
    this.navigationInFlight.set(inFlightKey, task);

    try {
      const result = await task;
      if (runRevision !== this.revision) {
        return this.getNavigationForUri(uri);
      }
      return result;
    } finally {
      this.navigationInFlight.delete(inFlightKey);
    }
  }

  async getAutoImportAnalysisForUri(
    uri: string,
  ): Promise<Parameters<typeof autoImportActions>[0]["analysis"]> {
    const { context, analysis } = await this.getCoreForUri(uri);
    const semanticExports = buildSemanticsExportIndex({
      semantics: analysis.semantics,
    });
    const workspaceExports = this.exportIndex.exportsForRoots(context.roots);
    const exportsByName = mergeExportIndexes({
      primary: semanticExports,
      secondary: workspaceExports,
    });

    return {
      moduleIdByFilePath: analysis.moduleIdByFilePath,
      semantics: analysis.semantics,
      graph: analysis.graph,
      exportsByName,
    };
  }
}

const publishDiagnosticsForOpenDocuments = async ({
  state,
  connection,
  runId,
  latestRunId,
}: {
  state: ServerState;
  connection: ReturnType<typeof createConnection>;
  runId: number;
  latestRunId: () => number;
}): Promise<void> => {
  const documents = state.documents.all();
  for (const document of documents) {
    if (runId !== latestRunId()) {
      return;
    }
    const { analysis } = await state.getCoreForUri(document.uri);
    if (runId !== latestRunId()) {
      return;
    }
    const diagnostics = analysis.diagnosticsByUri.get(document.uri) ?? [];
    connection.sendDiagnostics({
      uri: document.uri,
      diagnostics,
    });
  }
};

const handleDefinition = async ({
  params,
  state,
}: {
  params: DefinitionParams;
  state: ServerState;
}) => {
  const analysis = await state.getNavigationForUri(params.textDocument.uri);
  const definitions = definitionsAtPosition({
    analysis,
    uri: params.textDocument.uri,
    position: params.position,
  });
  return definitions;
};

const handlePrepareRename = async ({
  params,
  state,
}: {
  params: PrepareRenameParams;
  state: ServerState;
}) => {
  const analysis = await state.getNavigationForUri(params.textDocument.uri);
  return prepareRenameAtPosition({
    analysis,
    uri: params.textDocument.uri,
    position: params.position,
  });
};

const handleRename = async ({
  params,
  state,
}: {
  params: RenameParams;
  state: ServerState;
}) => {
  const analysis = await state.getNavigationForUri(params.textDocument.uri);
  return renameAtPosition({
    analysis,
    uri: params.textDocument.uri,
    position: params.position,
    newName: params.newName,
  });
};

const handleCodeActions = async ({
  params,
  state,
}: {
  params: CodeActionParams;
  state: ServerState;
}) => {
  const analysis = await state.getAutoImportAnalysisForUri(params.textDocument.uri);
  return autoImportActions({
    analysis,
    documentUri: params.textDocument.uri,
    diagnostics: params.context.diagnostics,
  });
};

export const startServer = ({
  connection = createConnection(ProposedFeatures.all),
}: StartServerOptions = {}): void => {
  const state = new ServerState();
  let diagnosticsRunId = 0;
  let diagnosticsTimer: ReturnType<typeof setTimeout> | undefined;

  const scheduleDiagnosticsPublish = (delayMs: number): void => {
    diagnosticsRunId += 1;
    const runId = diagnosticsRunId;
    if (diagnosticsTimer) {
      clearTimeout(diagnosticsTimer);
    }
    diagnosticsTimer = setTimeout(() => {
      void publishDiagnosticsForOpenDocuments({
        state,
        connection,
        runId,
        latestRunId: () => diagnosticsRunId,
      });
    }, delayMs);
  };

  connection.onInitialize((_params: InitializeParams): InitializeResult => ({
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      definitionProvider: true,
      renameProvider: {
        prepareProvider: true,
      },
      codeActionProvider: true,
    },
  }));

  state.documents.onDidOpen(({ document }: { document: TextDocument }) => {
    state.updateDocument(document);
    scheduleDiagnosticsPublish(25);
  });

  state.documents.onDidChangeContent(({ document }: { document: TextDocument }) => {
    state.updateDocument(document);
    scheduleDiagnosticsPublish(140);
  });

  state.documents.onDidClose(async ({ document }: { document: TextDocument }) => {
    await state.removeDocument(document);
    connection.sendDiagnostics({ uri: document.uri, diagnostics: [] });
    scheduleDiagnosticsPublish(25);
  });

  connection.onDidChangeWatchedFiles(async ({ changes }: DidChangeWatchedFilesParams) => {
    await state.handleWatchedFileChanges(changes);
    scheduleDiagnosticsPublish(80);
  });

  connection.onDefinition(async (params: DefinitionParams) =>
    handleDefinition({ params, state }),
  );

  connection.onPrepareRename(async (params: PrepareRenameParams) =>
    handlePrepareRename({ params, state }),
  );

  connection.onRenameRequest(async (params: RenameParams) =>
    handleRename({ params, state }),
  );

  connection.onCodeAction(async (params: CodeActionParams) =>
    handleCodeActions({ params, state }),
  );

  state.documents.listen(connection);
  connection.listen();
};

startServer();
