#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const distCli = resolve(here, "../dist/cli.js");
const srcCli = resolve(here, "../src/cli.ts");
const nodeOptions = process.env.NODE_OPTIONS ?? "";
const wantsSource =
  process.env.VOYD_DEV === "1" ||
  nodeOptions.includes("--conditions=development") ||
  nodeOptions.includes("tsx");

if (!wantsSource && existsSync(distCli)) {
  await import(pathToFileURL(distCli).href);
} else {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--conditions=development",
      srcCli,
      ...process.argv.slice(2),
    ],
    { stdio: "inherit" }
  );

  child.on("exit", (code) => process.exit(code ?? 1));
}
