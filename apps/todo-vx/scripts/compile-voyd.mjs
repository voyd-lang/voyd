import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const entryPath = resolve(rootDir, "src/main.voyd");
const outPath = resolve(rootDir, "src/generated/main.wasm");

export async function compileVoyd({ verbose = true } = {}) {
  await mkdir(dirname(outPath), { recursive: true });
  const wasm = await runVoyd(["--emit-wasm", "--opt", entryPath]);
  await writeFile(outPath, wasm);
  if (verbose) {
    console.log(`compiled ${entryPath} -> ${outPath}`);
  }
}

function runVoyd(args) {
  const command = process.platform === "win32" ? "voyd.cmd" : "voyd";

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];

    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      if (error && error.code === "ENOENT") {
        reject(new Error("Unable to find the voyd CLI. Run npm install before starting the app."));
        return;
      }
      reject(error);
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout));
        return;
      }

      const output = Buffer.concat(stderr).toString("utf8").trim();
      reject(new Error(output || `voyd exited with status ${code}`));
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await compileVoyd();
}
