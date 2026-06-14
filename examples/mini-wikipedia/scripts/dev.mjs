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
let restartQueued = false;

await buildClient();
await restartServer();

const watcher = watchSource();

function queueBuild() {
  buildQueued = true;
  if (building) return;
  setTimeout(() => void buildClient(), 75);
}

function queueRestart() {
  restartQueued = true;
  if (restarting) return;
  setTimeout(() => void restartServer(), 75);
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
    if (buildQueued) {
      setTimeout(() => void buildClient(), 75);
    }
  }
}

async function restartServer() {
  if (restarting) return;
  if (!restartQueued && app) return;
  restartQueued = false;
  restarting = true;
  try {
    if (app) {
      await app.close("restart").catch(() => undefined);
    }
    app = await serve({
      port: Number.isFinite(port) ? port : 3000,
      optimize: process.env.NODE_ENV === "production",
    });
    console.log(`Voyd wiki ready at ${app.url}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
  } finally {
    restarting = false;
    if (restartQueued) {
      setTimeout(() => void restartServer(), 75);
    }
  }
}

async function shutdown() {
  watcher?.close();
  if (app) {
    await app.close("shutdown").catch(() => undefined);
  }
  process.exit(0);
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

function run(name, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command(name), args, {
      cwd: rootDir,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${name} ${args.join(" ")} exited with code ${code}`));
    });
  });
}

function watchSource() {
  const watchers = new Map();

  const watchTree = (dir) => {
    watchDir(dir);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        watchTree(join(dir, entry.name));
      }
    }
  };

  const watchDir = (dir) => {
    if (watchers.has(dir)) return;
    const sourceWatcher = watch(dir, { persistent: true }, (_event, filename) => {
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
      handleSourceChange(filePath);
    });
    sourceWatcher.on("error", (error) => {
      console.error(`Source file watching stopped: ${error instanceof Error ? error.message : error}`);
    });
    watchers.set(dir, sourceWatcher);
  };

  try {
    watchTree(sourceDir);
  } catch (error) {
    console.error(`Source file watching unavailable: ${error instanceof Error ? error.message : error}`);
    return undefined;
  }
  return {
    close() {
      for (const sourceWatcher of watchers.values()) {
        sourceWatcher.close();
      }
      watchers.clear();
    },
  };
}

function handleSourceChange(filePath) {
  if (filePath.endsWith(".voyd")) {
    queueBuild();
    queueRestart();
    return;
  }
  if (filePath.endsWith(".css") || filePath.endsWith(".ts")) {
    queueBuild();
  }
}

function isDirectory(filePath) {
  try {
    return statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

function command(name) {
  return process.platform === "win32" ? `${name}.cmd` : name;
}
