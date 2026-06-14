import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "./serve.mjs";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const sourceDir = resolve(rootDir, "src");
const port = Number.parseInt(process.env.PORT ?? process.env.VOYD_WEB_PORT ?? "3000", 10);
const vite = spawn(command("vite"), ["build", "--watch", "--mode", "development"], {
  cwd: rootDir,
  stdio: "inherit",
});

let app;
let restarting = false;
let queued = false;

await restart();

const watcher = watch(sourceDir, { persistent: true }, (_event, filename) => {
  if (!filename || !filename.endsWith(".voyd")) return;
  queueRestart();
});

function queueRestart() {
  queued = true;
  if (restarting) return;
  setTimeout(() => void restart(), 75);
}

async function restart() {
  if (!queued && app) return;
  queued = false;
  restarting = true;
  try {
    if (app) {
      await app.close("restart").catch(() => undefined);
    }
    app = await serve({
      port: Number.isFinite(port) ? port : 3000,
      optimize: false,
    });
    console.log(`Voyd wiki ready at ${app.url}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
  } finally {
    restarting = false;
    if (queued) {
      setTimeout(() => void restart(), 75);
    }
  }
}

async function shutdown() {
  watcher.close();
  vite.kill("SIGTERM");
  if (app) {
    await app.close("shutdown").catch(() => undefined);
  }
  process.exit(0);
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
vite.once("exit", (code) => {
  if (code && code !== 0) {
    process.exitCode = code;
  }
});

function command(name) {
  return process.platform === "win32" ? `${name}.cmd` : name;
}
