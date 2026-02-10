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
  context.asAbsolutePath(path.join("dist", "server.js"));

const resolveStdRoot = (context: vscode.ExtensionContext): string =>
  context.asAbsolutePath(path.join("dist", "std"));

export const activate = (context: vscode.ExtensionContext): void => {
  const serverEntry = resolveServerEntry(context);
  const stdRoot = resolveStdRoot(context);
  const env = { ...process.env, VOYD_STD_ROOT: stdRoot };

  const run: Executable = {
    command: process.execPath,
    args: [serverEntry, "--stdio"],
    options: { env },
  };

  const serverOptions: ServerOptions = {
    run,
    debug: {
      command: process.execPath,
      args: ["--inspect=6009", serverEntry, "--stdio"],
      options: { env },
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
