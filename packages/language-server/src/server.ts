import {
  createConnection,
  ProposedFeatures,
  TextDocuments,
  TextDocumentSyncKind,
  type CodeActionParams,
  type DefinitionParams,
  type DidChangeWatchedFilesParams,
  type HoverParams,
  type InitializeParams,
  type InitializeResult,
  type PrepareRenameParams,
  type RenameParams,
} from "vscode-languageserver/lib/node/main.js";
import { TextDocument } from "vscode-languageserver-textdocument";
import {
  autoImportActions,
  definitionsAtPosition,
  hoverAtPosition,
  prepareRenameAtPosition,
  renameAtPosition,
} from "./project.js";
import { AnalysisCoordinator } from "./server/analysis-coordinator.js";
import { DiagnosticsScheduler, type DiagnosticsRun } from "./server/diagnostics-scheduler.js";

export type StartServerOptions = {
  connection?: ReturnType<typeof createConnection>;
};

const publishDiagnosticsForOpenDocuments = async ({
  run,
  coordinator,
  documents,
  connection,
}: {
  run: DiagnosticsRun;
  coordinator: AnalysisCoordinator;
  documents: TextDocuments<TextDocument>;
  connection: ReturnType<typeof createConnection>;
}): Promise<void> => {
  for (const document of documents.all()) {
    if (!run.isCurrent()) {
      return;
    }
    const { analysis } = await coordinator.getCoreForUri(document.uri);
    if (!run.isCurrent()) {
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
  coordinator,
}: {
  params: DefinitionParams;
  coordinator: AnalysisCoordinator;
}) => {
  const analysis = await coordinator.getNavigationForUri(params.textDocument.uri);
  return definitionsAtPosition({
    analysis,
    uri: params.textDocument.uri,
    position: params.position,
  });
};

const handlePrepareRename = async ({
  params,
  coordinator,
}: {
  params: PrepareRenameParams;
  coordinator: AnalysisCoordinator;
}) => {
  const analysis = await coordinator.getNavigationForUri(params.textDocument.uri);
  return prepareRenameAtPosition({
    analysis,
    uri: params.textDocument.uri,
    position: params.position,
  });
};

const handleRename = async ({
  params,
  coordinator,
}: {
  params: RenameParams;
  coordinator: AnalysisCoordinator;
}) => {
  const analysis = await coordinator.getNavigationForUri(params.textDocument.uri);
  return renameAtPosition({
    analysis,
    uri: params.textDocument.uri,
    position: params.position,
    newName: params.newName,
  });
};

const handleCodeActions = async ({
  params,
  coordinator,
}: {
  params: CodeActionParams;
  coordinator: AnalysisCoordinator;
}) => {
  const analysis = await coordinator.getAutoImportAnalysisForUri(params.textDocument.uri);
  return autoImportActions({
    analysis,
    documentUri: params.textDocument.uri,
    diagnostics: params.context.diagnostics,
  });
};

const handleHover = async ({
  params,
  coordinator,
}: {
  params: HoverParams;
  coordinator: AnalysisCoordinator;
}) => {
  const analysis = await coordinator.getNavigationForUri(params.textDocument.uri);
  return hoverAtPosition({
    analysis,
    uri: params.textDocument.uri,
    position: params.position,
  });
};

export const startServer = ({
  connection = createConnection(ProposedFeatures.all),
}: StartServerOptions = {}): void => {
  const documents = new TextDocuments(TextDocument);
  const coordinator = new AnalysisCoordinator();
  const diagnosticsScheduler = new DiagnosticsScheduler();

  const scheduleDiagnosticsPublish = (delayMs: number): void => {
    diagnosticsScheduler.schedule({
      delayMs,
      publish: (run) =>
        publishDiagnosticsForOpenDocuments({
          run,
          coordinator,
          documents,
          connection,
        }),
    });
  };

  connection.onInitialize((_params: InitializeParams): InitializeResult => ({
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      definitionProvider: true,
      hoverProvider: true,
      renameProvider: {
        prepareProvider: true,
      },
      codeActionProvider: true,
    },
  }));

  documents.onDidOpen(({ document }: { document: TextDocument }) => {
    coordinator.updateDocument(document);
    scheduleDiagnosticsPublish(25);
  });

  documents.onDidChangeContent(({ document }: { document: TextDocument }) => {
    coordinator.updateDocument(document);
    scheduleDiagnosticsPublish(140);
  });

  documents.onDidClose(async ({ document }: { document: TextDocument }) => {
    await coordinator.removeDocument(document);
    connection.sendDiagnostics({ uri: document.uri, diagnostics: [] });
    scheduleDiagnosticsPublish(25);
  });

  connection.onDidChangeWatchedFiles(async ({ changes }: DidChangeWatchedFilesParams) => {
    const changed = await coordinator.handleWatchedFileChanges(changes);
    if (changed) {
      scheduleDiagnosticsPublish(80);
    }
  });

  connection.onDefinition(async (params: DefinitionParams) =>
    handleDefinition({ params, coordinator }),
  );

  connection.onPrepareRename(async (params: PrepareRenameParams) =>
    handlePrepareRename({ params, coordinator }),
  );

  connection.onRenameRequest(async (params: RenameParams) =>
    handleRename({ params, coordinator }),
  );

  connection.onCodeAction(async (params: CodeActionParams) =>
    handleCodeActions({ params, coordinator }),
  );

  connection.onHover(async (params: HoverParams) =>
    handleHover({ params, coordinator }),
  );

  documents.listen(connection);
  connection.onShutdown(() => diagnosticsScheduler.dispose());
  connection.listen();
};

startServer();
