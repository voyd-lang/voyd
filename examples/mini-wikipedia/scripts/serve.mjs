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

  const close = async () => {
    await app.close("shutdown").catch(() => undefined);
    process.exit(0);
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  await app.closed.catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
