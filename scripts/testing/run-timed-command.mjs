import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const args = process.argv.slice(2);
const separator = args.indexOf("--");
if (separator < 0 || separator === args.length - 1) {
  throw new Error(
    "Usage: run-timed-command.mjs --lane <lane> --output <file> -- <command> [args...]",
  );
}

const optionArgs = args.slice(0, separator);
const commandArgs = args.slice(separator + 1);
const lane = valueFor("--lane");
const output = resolve(valueFor("--output"));
const [command, ...commandArguments] = commandArgs;
const startTime = Date.now();
const result = spawnSync(command, commandArguments, {
  env: process.env,
  stdio: "inherit",
});
const endTime = Date.now();

mkdirSync(dirname(output), { recursive: true });
writeFileSync(
  output,
  `${JSON.stringify(
    {
      kind: "lane-wall",
      lane,
      command: commandArgs,
      startTime,
      endTime,
      wallMs: endTime - startTime,
      status: result.status,
      signal: result.signal,
      error: result.error?.message,
    },
    null,
    2,
  )}\n`,
);

if (result.error) {
  throw result.error;
}
process.exitCode = result.status ?? 1;

function valueFor(name) {
  const index = optionArgs.indexOf(name);
  if (index < 0 || !optionArgs[index + 1]) {
    throw new Error(`Missing ${name}`);
  }
  return optionArgs[index + 1];
}
