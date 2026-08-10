import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { voydCommand } from "./voyd-command.mjs";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const invocation = voydCommand(rootDir, ["test", "src", "--fail-empty-tests"]);
const child = spawn(invocation.command, invocation.args, {
  cwd: rootDir,
  env: invocation.env,
  stdio: "inherit",
});

child.once("error", (error) => {
  console.error(error);
  process.exit(1);
});
child.once("exit", (code) => process.exit(code ?? 1));
