import { spawn } from "node:child_process";
import { readdirSync, statSync, watch } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "./serve.mjs";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const sourceDir = resolve(rootDir, "src");
const port = Number.parseInt(process.env.PORT ?? process.env.VOYD_WEB_PORT ?? "3000", 10);
let app;
let building = false;
let restarting = false;
let buildQueued = false;
let restartQueued = true;

await buildClient();
await restartServer();
const watcher = watchSource();

function queueBuild() {
  buildQueued = true;
  if (!building) setTimeout(() => void buildClient(), 75);
}

function queueRestart() {
  restartQueued = true;
  if (!restarting) setTimeout(() => void restartServer(), 75);
}

async function buildClient() {
  if (building) return;
  buildQueued = false;
  building = true;
  try {
    await run("vite", ["build", "--mode", "development"]);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
  } finally {
    building = false;
    if (buildQueued) setTimeout(() => void buildClient(), 75);
  }
}

async function restartServer() {
  if (restarting || (!restartQueued && app)) return;
  restartQueued = false;
  restarting = true;
  try {
    if (app) await app.close("restart").catch(() => undefined);
    app = await serve({
      port: Number.isFinite(port) ? port : 3000,
      optimize: process.env.NODE_ENV === "production",
    });
    console.log(`Voyd Orbit ready at ${app.url}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
  } finally {
    restarting = false;
    if (restartQueued) setTimeout(() => void restartServer(), 75);
  }
}

function run(name, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.platform === "win32" ? `${name}.cmd` : name, args, {
      cwd: rootDir,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolvePromise() : reject(new Error(`${name} exited with ${code}`)));
  });
}

function watchSource() {
  const watchers = new Map();
  const watchTree = (dir) => {
    if (watchers.has(dir)) return;
    const sourceWatcher = watch(dir, (_event, filename) => {
      if (!filename) {
        queueBuild();
        queueRestart();
        return;
      }
      const filePath = join(dir, filename.toString());
      if (isDirectory(filePath)) {
        watchTree(filePath);
        return;
      }
      if (filePath.endsWith(".voyd")) {
        queueBuild();
        queueRestart();
      } else if (filePath.endsWith(".css") || filePath.endsWith(".mjs")) {
        queueBuild();
      }
    });
    watchers.set(dir, sourceWatcher);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) watchTree(join(dir, entry.name));
    }
  };
  watchTree(sourceDir);
  return { close: () => watchers.forEach((sourceWatcher) => sourceWatcher.close()) };
}

function isDirectory(filePath) {
  try {
    return statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

async function shutdown() {
  watcher.close();
  if (app) await app.close("shutdown").catch(() => undefined);
  process.exit(0);
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
