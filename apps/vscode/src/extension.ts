import path from "node:path";
import * as vscode from "vscode";
import {
  LanguageClient,
  LanguageClientOptions,
  Executable,
  ServerOptions,
} from "vscode-languageclient/node";

let client: LanguageClient | undefined;

const resolveServerEntry = (context: vscode.ExtensionContext): string =>
  require.resolve("@voyd/language-server/src/server.ts", {
    paths: [
      context.extensionPath,
      path.resolve(context.extensionPath, ".."),
      path.resolve(context.extensionPath, "..", ".."),
    ],
  });

const resolveTsxLoader = (context: vscode.ExtensionContext): string =>
  require.resolve("tsx", {
    paths: [
      context.extensionPath,
      path.resolve(context.extensionPath, ".."),
      path.resolve(context.extensionPath, "..", ".."),
    ],
  });

export const activate = (context: vscode.ExtensionContext): void => {
  const serverEntry = resolveServerEntry(context);
  const tsxLoader = resolveTsxLoader(context);

  const run: Executable = {
    command: process.execPath,
    args: ["--conditions=development", "--import", tsxLoader, serverEntry, "--stdio"],
  };

  const serverOptions: ServerOptions = {
    run,
    debug: {
      command: process.execPath,
      args: [
        "--inspect=6009",
        "--conditions=development",
        "--import",
        tsxLoader,
        serverEntry,
        "--stdio",
      ],
    },
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: "file", language: "voyd" }],
    synchronize: {
      fileEvents: vscode.workspace.createFileSystemWatcher("**/*.{voyd,vd}"),
    },
  };

  client = new LanguageClient(
    "voyd-language-server",
    "Voyd Language Server",
    serverOptions,
    clientOptions,
  );

  context.subscriptions.push(client);
  void client.start();
};

export const deactivate = async (): Promise<void> => {
  if (!client) {
    return;
  }
  await client.stop();
  client = undefined;
};
