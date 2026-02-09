import path from "node:path";
import {
  createConnection,
  ProposedFeatures,
  TextDocuments,
  TextDocumentSyncKind,
  type CodeActionParams,
  type DefinitionParams,
  type InitializeParams,
  type InitializeResult,
  type PrepareRenameParams,
  type RenameParams,
} from "vscode-languageserver/lib/node/main.js";
import { TextDocument } from "vscode-languageserver-textdocument";
import { URI } from "vscode-uri";
import {
  analyzeProject,
  autoImportActions,
  definitionsAtPosition,
  prepareRenameAtPosition,
  renameAtPosition,
  resolveEntryPath,
  resolveModuleRoots,
  type ProjectAnalysis,
} from "./project.js";

export type StartServerOptions = {
  connection?: ReturnType<typeof createConnection>;
};

type AnalysisCache = {
  entryPath: string;
  analysis: ProjectAnalysis;
};

class ServerState {
  readonly documents = new TextDocuments(TextDocument);
  readonly openDocuments = new Map<string, string>();
  private readonly cache = new Map<string, AnalysisCache>();

  updateDocument(document: TextDocument): void {
    const filePath = path.resolve(URI.parse(document.uri).fsPath);
    this.openDocuments.set(filePath, document.getText());
    this.cache.clear();
  }

  removeDocument(document: TextDocument): void {
    const filePath = path.resolve(URI.parse(document.uri).fsPath);
    this.openDocuments.delete(filePath);
    this.cache.clear();
  }

  async getAnalysisForUri(uri: string): Promise<ProjectAnalysis> {
    const filePath = path.resolve(URI.parse(uri).fsPath);
    const entryPath = await resolveEntryPath(filePath);
    const cached = this.cache.get(entryPath);
    if (cached) {
      return cached.analysis;
    }

    const roots = resolveModuleRoots(entryPath);
    const analysis = await analyzeProject({
      entryPath,
      roots,
      openDocuments: this.openDocuments,
    });
    this.cache.set(entryPath, { entryPath, analysis });
    return analysis;
  }
}

const publishDiagnostics = async ({
  state,
  connection,
  targetUri,
}: {
  state: ServerState;
  connection: ReturnType<typeof createConnection>;
  targetUri: string;
}): Promise<void> => {
  const analysis = await state.getAnalysisForUri(targetUri);

  state.documents.all().forEach((document: TextDocument) => {
    const diagnostics = analysis.diagnosticsByUri.get(document.uri) ?? [];
    connection.sendDiagnostics({
      uri: document.uri,
      diagnostics,
    });
  });
};

const handleDefinition = async ({
  params,
  state,
}: {
  params: DefinitionParams;
  state: ServerState;
}) => {
  const analysis = await state.getAnalysisForUri(params.textDocument.uri);
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
  const analysis = await state.getAnalysisForUri(params.textDocument.uri);
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
  const analysis = await state.getAnalysisForUri(params.textDocument.uri);
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
  const analysis = await state.getAnalysisForUri(params.textDocument.uri);
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

  state.documents.onDidOpen(async ({ document }: { document: TextDocument }) => {
    state.updateDocument(document);
    await publishDiagnostics({
      state,
      connection,
      targetUri: document.uri,
    });
  });

  state.documents.onDidChangeContent(async ({ document }: { document: TextDocument }) => {
    state.updateDocument(document);
    await publishDiagnostics({
      state,
      connection,
      targetUri: document.uri,
    });
  });

  state.documents.onDidClose(async ({ document }: { document: TextDocument }) => {
    state.removeDocument(document);
    connection.sendDiagnostics({ uri: document.uri, diagnostics: [] });
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
