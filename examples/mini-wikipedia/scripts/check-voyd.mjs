import { createSdk } from "@voyd-lang/sdk";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const entryPath = resolve(rootDir, "src/main.voyd");
const sdk = createSdk();
const result = await sdk.compile({
  entryPath,
  optimize: true,
  runtimeDiagnostics: true,
});

if (!result.success) {
  console.error(formatDiagnostics(result.diagnostics));
  process.exit(1);
}

console.log("Voyd server compiled successfully.");

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
