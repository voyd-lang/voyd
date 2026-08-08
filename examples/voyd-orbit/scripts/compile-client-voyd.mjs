import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { voydCommand } from "./voyd-command.mjs";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const entryPath = resolve(rootDir, "src/client.voyd");
const outPath = resolve(rootDir, "src/generated/client.wasm");

export async function compileClientVoyd({ verbose = true } = {}) {
  await mkdir(dirname(outPath), { recursive: true });
  const wasm = await runVoyd(["--emit-wasm", "--opt", entryPath]);
  await writeFile(outPath, wasm);
  if (verbose) console.log(`compiled ${entryPath} -> ${outPath}`);
}

function runVoyd(args) {
  const invocation = voydCommand(rootDir, args);
  return new Promise((resolvePromise, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: rootDir,
      env: invocation.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise(Buffer.concat(stdout));
        return;
      }
      reject(new Error(Buffer.concat(stderr).toString("utf8").trim() || `voyd exited with status ${code}`));
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await compileClientVoyd();
}
