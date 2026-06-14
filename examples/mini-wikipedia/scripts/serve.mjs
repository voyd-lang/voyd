import { createSdk } from "@voyd-lang/sdk";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const entryPath = resolve(rootDir, "src/main.voyd");
process.chdir(rootDir);

export async function serve({
  host = process.env.HOST ?? process.env.VOYD_WEB_HOST ?? "127.0.0.1",
  port = readPort(),
  optimize = true,
} = {}) {
  const sdk = createSdk();
  const result = await sdk.serveWebApp({
    entryPath,
    host,
    port,
    optimize,
    runtimeDiagnostics: true,
    run: {
      bufferSize: 1024 * 1024,
      defaultAdapters: { runtime: "node" },
    },
  });

  if (!result.success) {
    throw new Error(formatDiagnostics(result.diagnostics));
  }

  return result;
}

function readPort() {
  const raw = process.env.PORT ?? process.env.VOYD_WEB_PORT ?? "3000";
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : 3000;
}

function formatDiagnostics(diagnostics) {
  return diagnostics
    .map((diagnostic) => {
      const location = diagnostic.location
        ? `${diagnostic.location.filePath}:${diagnostic.location.start.line}:${diagnostic.location.start.column}`
        : diagnostic.file ?? "voyd";
      return `${location} ${diagnostic.severity}: ${diagnostic.message}`;
    })
    .join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let app;
  try {
    app = await serve();
    console.log(`Voyd wiki ready at ${app.url}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }

  let closing = false;
  const keepAlive = setInterval(() => undefined, 1_000_000_000);
  app.closed.catch((error) => {
    if (closing) return;
    clearInterval(keepAlive);
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });

  await waitForShutdown(async (signal) => {
    closing = true;
    clearInterval(keepAlive);
    await app.close(signal).catch(() => undefined);
  });
}

function waitForShutdown(close) {
  return new Promise((resolve) => {
    let closing = false;
    const shutdown = (signal) => {
      if (closing) return;
      closing = true;
      void close(signal).finally(resolve);
    };
    process.once("SIGINT", () => shutdown("SIGINT"));
    process.once("SIGTERM", () => shutdown("SIGTERM"));
  });
}
