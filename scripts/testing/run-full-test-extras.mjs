import { spawn } from "node:child_process";

const npmCli = process.env.npm_execpath;
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

const commands = [
  ["run", "test:codegen"],
  ["run", "--workspace", "@voyd-lang/cli", "test:e2e"],
];
const statuses = await Promise.all(commands.map(runNpm));

process.exitCode = statuses.every((status) => status === 0) ? 0 : 1;

function runNpm(args) {
  return new Promise((resolve, reject) => {
    const command = npmCli ? process.execPath : npmCommand;
    const commandArgs = npmCli ? [npmCli, ...args] : args;
    const child = spawn(command, commandArgs, {
      env: process.env,
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("exit", (status) => resolve(status ?? 1));
  });
}
