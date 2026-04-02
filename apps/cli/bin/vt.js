#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const srcCli = resolve(here, "../src/cli.ts");
const distCli = resolve(here, "../dist/cli.js");

if (existsSync(srcCli)) {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--conditions=development",
      srcCli,
      ...process.argv.slice(2),
    ],
    { stdio: "inherit" },
  );

  child.on("exit", (code) => process.exit(code ?? 1));
} else if (existsSync(distCli)) {
  await import(pathToFileURL(distCli).href);
} else {
  throw new Error("Could not find src or dist CLI entry for vt.");
}
