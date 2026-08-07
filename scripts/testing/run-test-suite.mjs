#!/usr/bin/env node
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const npmCli = process.env.npm_execpath;
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

export function testLanes({ force = false } = {}) {
  const forceArg = force ? ["--force"] : [];

  return [
    {
      name: "release and test tooling",
      steps: [npmStep(["run", "test:tooling"], "source")],
    },
    {
      name: "workspace tests",
      steps: [
        npmStep(
          [
            "exec",
            "--",
            "turbo",
            "run",
            "test",
            "--output-logs=errors-only",
            ...forceArg,
          ],
          "source",
        ),
      ],
    },
    {
      name: "compiler codegen",
      steps: [npmStep(["run", "test:codegen"], "source")],
    },
    {
      name: "CLI source e2e",
      steps: [
        npmStep(
          ["run", "--workspace", "@voyd-lang/cli", "test:e2e"],
          "source",
        ),
      ],
    },
    {
      name: "CLI dist e2e",
      steps: [
        npmStep([
          "exec",
          "--",
          "turbo",
          "run",
          "build",
          "--filter=@voyd-lang/cli...",
          "--output-logs=errors-only",
          ...forceArg,
        ]),
        npmStep(
          ["run", "--workspace", "@voyd-lang/cli", "test:e2e"],
          "dist",
        ),
      ],
    },
  ];
}

export function executionPhases({ isCi, force = false }) {
  const lanes = testLanes({ force });
  if (isCi) return lanes.map((lane) => [lane]);
  return [[lanes[0], lanes[1]], lanes.slice(2)];
}

async function run() {
  const args = process.argv.slice(2);
  const unknownArgs = args.filter((arg) => arg !== "--force");
  if (unknownArgs.length > 0) {
    throw new Error(`Unknown test-suite arguments: ${unknownArgs.join(", ")}`);
  }

  const phases = executionPhases({
    isCi: process.env.CI !== undefined,
    force: args.includes("--force"),
  });
  for (const phase of phases) {
    const statuses = await Promise.all(phase.map(runLane));
    if (statuses.some((status) => status !== 0)) {
      process.exitCode = 1;
      return;
    }
  }
}

async function runLane(lane) {
  process.stdout.write(`\n[${lane.name}]\n`);
  for (const step of lane.steps) {
    const status = await runNpm(step);
    if (status !== 0) return status;
  }
  return 0;
}

function npmStep(args, runtime = "inherit") {
  return { args, runtime };
}

function runNpm({ args, runtime }) {
  return new Promise((resolveStatus, reject) => {
    const command = npmCli ? process.execPath : npmCommand;
    const commandArgs = npmCli ? [npmCli, ...args] : args;
    const child = spawn(command, commandArgs, {
      env: runtimeEnvironment(runtime),
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("exit", (status) => resolveStatus(status ?? 1));
  });
}

function runtimeEnvironment(runtime) {
  const environment = { ...process.env };
  if (runtime === "source") {
    delete environment.VOYD_USE_DIST;
    delete environment.VOYD_CLI_E2E_RUNTIME;
    environment.VOYD_USE_SRC = "1";
  }
  if (runtime === "dist") {
    delete environment.VOYD_USE_SRC;
    environment.VOYD_USE_DIST = "1";
    environment.VOYD_CLI_E2E_RUNTIME = "dist";
  }
  return environment;
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  await run();
}
