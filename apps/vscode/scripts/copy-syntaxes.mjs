import { copyFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.resolve(scriptDir, "..");
const libPackagePath = require.resolve("@voyd/lib/package.json");
const libRoot = path.dirname(libPackagePath);
const sourceDir = path.resolve(libRoot, "assets");
const targetDir = path.resolve(extensionRoot, "syntaxes");
const syntaxFiles = ["voyd.tmLanguage.json", "voyd-markdown-injection.json"];

await mkdir(targetDir, { recursive: true });

await Promise.all(
  syntaxFiles.map((filename) =>
    copyFile(path.resolve(sourceDir, filename), path.resolve(targetDir, filename)),
  ),
);
