import { execFileSync } from "node:child_process";
import {
  collectPublishDependencies,
  getTarget,
  parseTargetSelection,
  readTargetPackageJson,
  repoRoot,
  resolveTargetCwd,
} from "./manifest.mjs";

const inheritEnv = (extraEnv = {}) => ({
  ...process.env,
  ...extraEnv,
});

const readStdout = ({ command, args, cwd = repoRoot, env }) =>
  execFileSync(command, args, {
    cwd,
    env: inheritEnv(env),
    encoding: "utf8",
    stdio: ["inherit", "pipe", "pipe"],
  });

export const runCommand = ({ command, args, cwd = repoRoot, env }) => {
  const printable = [command, ...args].join(" ");
  process.stdout.write(`\n[release] ${printable}\n`);
  execFileSync(command, args, {
    cwd,
    env: inheritEnv(env),
    stdio: "inherit",
  });
};

const npmRunWorkspaceScript = ({ workspace, script, args = [], env }) =>
  runCommand({
    command: "npm",
    args: ["run", "--workspace", workspace, script, ...args],
    env,
  });

const needsRelatedTest = (targetNames, relatedTest) =>
  targetNames.some((targetName) => getTarget(targetName).relatedTests.includes(relatedTest));

const runTurboBuild = (targetNames) => {
  const filters = targetNames
    .filter((targetName) => getTarget(targetName).kind === "npm")
    .flatMap((targetName) => ["--filter", `${targetName}...`]);

  if (filters.length === 0) {
    return;
  }

  runCommand({
    command: "npx",
    args: [
      "turbo",
      "run",
      "build",
      "--output-logs=errors-only",
      "--log-order=grouped",
      "--force",
      "--no-cache",
      ...filters,
    ],
  });
};

const runTurboClean = (targetNames) => {
  const filters = targetNames
    .filter((targetName) => getTarget(targetName).kind === "npm")
    .flatMap((targetName) => ["--filter", `${targetName}...`]);

  if (filters.length === 0) {
    return;
  }

  runCommand({
    command: "npx",
    args: [
      "turbo",
      "run",
      "clean",
      "--output-logs=errors-only",
      "--log-order=grouped",
      "--force",
      "--no-cache",
      ...filters,
    ],
  });
};

const validatePackContents = (targetName) => {
  const target = getTarget(targetName);
  if (target.kind !== "npm") {
    return;
  }

  const raw = readStdout({
    command: "npm",
    args: [
      "pack",
      "--dry-run",
      "--json",
      "--ignore-scripts",
      "--workspace",
      target.workspace,
    ],
  });
  const [packResult] = JSON.parse(raw);
  const filePaths = new Set(packResult.files.map((file) => file.path));

  const missingFiles = target.packRequiredFiles.filter((requiredPath) => !filePaths.has(requiredPath));
  if (missingFiles.length > 0) {
    throw new Error(
      `${targetName} is missing expected pack files: ${missingFiles.join(", ")}`,
    );
  }

  const forbiddenFiles = packResult.files
    .map((file) => file.path)
    .filter((filePath) => target.packForbiddenPatterns.some((pattern) => pattern.test(filePath)));
  if (forbiddenFiles.length > 0) {
    throw new Error(
      `${targetName} pack output still includes repo-only files: ${forbiddenFiles.join(", ")}`,
    );
  }
};

const runOwnChecks = (targetNames) => {
  targetNames.forEach((targetName) => {
    const target = getTarget(targetName);

    npmRunWorkspaceScript({ workspace: target.workspace, script: "typecheck" });

    if (target.relatedTests.includes("own")) {
      npmRunWorkspaceScript({ workspace: target.workspace, script: "test" });
    }
  });
};

const runSmokeChecks = (targetNames) => {
  if (!needsRelatedTest(targetNames, "smoke")) {
    return;
  }

  npmRunWorkspaceScript({ workspace: "@voyd-lang/smoke", script: "test" });
};

const runCliDistChecks = (targetNames) => {
  if (!needsRelatedTest(targetNames, "cli-dist")) {
    return;
  }

  runCommand({
    command: "npx",
    args: [
      "turbo",
      "run",
      "build",
      "--filter",
      "@voyd-lang/cli...",
      "--output-logs=errors-only",
      "--log-order=grouped",
      "--force",
      "--no-cache",
    ],
  });

  npmRunWorkspaceScript({
    workspace: "@voyd-lang/cli",
    script: "test",
    args: ["--", "src/__tests__/cli-e2e.test.ts"],
    env: {
      VOYD_USE_DIST: "1",
      VOYD_CLI_E2E_RUNTIME: "dist",
    },
  });
};

const runVscodePackageCheck = (targetNames) => {
  if (!targetNames.includes("voyd-vscode")) {
    return;
  }

  npmRunWorkspaceScript({ workspace: "voyd-vscode", script: "package" });
};

export const runReleaseCheck = ({ targetNames }) => {
  runTurboClean(targetNames);
  runTurboBuild(targetNames);
  runOwnChecks(targetNames);
  runSmokeChecks(targetNames);
  runCliDistChecks(targetNames);
  runVscodePackageCheck(targetNames);
  targetNames.forEach(validatePackContents);
};

export const parseSharedArgs = (argv) => {
  const targetNames = parseTargetSelection(argv);
  const options = {
    targetNames,
    dryRun: argv.includes("--dry-run"),
    allowDirty: argv.includes("--allow-dirty"),
    tag: "latest",
    otp: undefined,
    vscodeRelease: undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--tag") {
      options.tag = argv[index + 1] ?? options.tag;
      index += 1;
      continue;
    }

    if (arg.startsWith("--tag=")) {
      options.tag = arg.split("=")[1] ?? options.tag;
      continue;
    }

    if (arg === "--otp") {
      options.otp = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg.startsWith("--otp=")) {
      options.otp = arg.split("=")[1];
      continue;
    }

    if (arg === "--release" || arg === "--vscode-release") {
      options.vscodeRelease = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg.startsWith("--release=") || arg.startsWith("--vscode-release=")) {
      options.vscodeRelease = arg.split("=")[1];
    }
  }

  return options;
};

export const assertCleanWorktree = () => {
  const status = readStdout({
    command: "git",
    args: ["status", "--short"],
  }).trim();

  if (status.length > 0) {
    throw new Error("Release publish requires a clean git worktree. Commit or stash changes first.");
  }
};

export const sortNpmTargetsForPublish = (targetNames) => {
  const npmTargetNames = targetNames.filter((targetName) => getTarget(targetName).kind === "npm");
  const selected = new Set(npmTargetNames);
  const visited = new Set();
  const visiting = new Set();
  const sorted = [];

  const visit = (targetName) => {
    if (visited.has(targetName)) {
      return;
    }

    if (visiting.has(targetName)) {
      throw new Error(`Release target cycle detected at ${targetName}`);
    }

    visiting.add(targetName);
    collectPublishDependencies(targetName)
      .filter((depName) => selected.has(depName))
      .forEach(visit);
    visiting.delete(targetName);
    visited.add(targetName);
    sorted.push(targetName);
  };

  npmTargetNames.forEach(visit);
  return sorted;
};

export const publishNpmTargets = ({ targetNames, dryRun, tag, otp }) => {
  sortNpmTargetsForPublish(targetNames).forEach((targetName) => {
    const target = getTarget(targetName);
    const args = ["publish", "--workspace", target.workspace, "--tag", tag];

    if (target.access) {
      args.push("--access", target.access);
    }

    if (dryRun) {
      args.push("--dry-run");
    }

    if (otp) {
      args.push("--otp", otp);
    }

    runCommand({
      command: "npm",
      args,
      env: {
        VOYD_RELEASE_SKIP_PUBLISH_CHECK: "1",
      },
    });
  });
};

export const runVscodePublish = ({ dryRun, release }) => {
  if (dryRun) {
    npmRunWorkspaceScript({ workspace: "voyd-vscode", script: "package" });
    return;
  }

  if (!release) {
    throw new Error("Publishing voyd-vscode requires --release patch|minor|major|<version>.");
  }

  runCommand({
    command: "npx",
    args: ["vsce", "publish", release, "--no-dependencies"],
    cwd: resolveTargetCwd("voyd-vscode"),
    env: {
      VOYD_RELEASE_SKIP_PUBLISH_CHECK: "1",
    },
  });
};

export const resolveWorkspaceNameFromEnv = () => {
  const workspace = process.env.npm_package_name;
  if (!workspace) {
    throw new Error("npm_package_name is not set for this workspace publish hook.");
  }

  getTarget(workspace);
  return workspace;
};

export const describeTargets = (targetNames) =>
  targetNames.map((targetName) => {
    const target = getTarget(targetName);
    const packageJson = target.kind === "npm" ? readTargetPackageJson(targetName) : null;
    const version = packageJson?.version ?? "extension";
    return {
      targetName,
      kind: target.kind,
      version,
      cwd: target.cwd,
      description: target.description,
    };
  });
