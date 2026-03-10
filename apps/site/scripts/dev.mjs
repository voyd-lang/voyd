import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const scriptsDir = path.dirname(__filename);
const siteRoot = path.resolve(scriptsDir, "..");
const repoRoot = path.resolve(siteRoot, "..", "..");
const referenceRoot = path.resolve(repoRoot, "packages/reference");
const reactRouterCmd = path.resolve(
  repoRoot,
  "node_modules/.bin",
  process.platform === "win32" ? "react-router.cmd" : "react-router"
);

const children = [
  spawnProcess({
    name: "reference",
    cmd: process.execPath,
    cwd: referenceRoot,
    args: [path.resolve(referenceRoot, "scripts/build.mjs"), "--watch"],
  }),
  spawnProcess({
    name: "site",
    cmd: reactRouterCmd,
    cwd: siteRoot,
    args: ["dev", "--host"],
    env: {
      CHOKIDAR_INTERVAL: "250",
      CHOKIDAR_USEPOLLING: "true",
    },
  }),
];

let shuttingDown = false;
const keepAlive = setInterval(() => {}, 1_000);
const exits = children.map(
  (child) =>
    new Promise((resolve) => {
      child.once("exit", (code, signal) => {
        resolve({ code, signal });
      });
    })
);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.exitCode = 0;
    stopChildren(signal);
  });
}

function spawnProcess({ name, cmd, cwd, args, env = {} }) {
  const child = spawn(cmd, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: "inherit",
  });

  child.on("error", (error) => {
    process.stderr.write(`[site dev] failed to start ${name}: ${String(error)}\n`);
    process.exit(1);
  });

  return child;
}

function stopChildren(signal) {
  const killSignal = signal ?? "SIGTERM";

  for (const child of children) {
    if (child.killed) continue;
    child.kill(killSignal);
  }
}

const firstExit = await Promise.race(exits);

if (!shuttingDown) {
  shuttingDown = true;
  process.exitCode = firstExit.code ?? (firstExit.signal ? 1 : 0);
  stopChildren(firstExit.signal);
}

await Promise.allSettled(exits);
clearInterval(keepAlive);
