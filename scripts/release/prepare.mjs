import { execFileSync } from "node:child_process";
import {
  parseTargetSelection,
  repoRoot,
} from "./manifest.mjs";
import {
  assertCleanWorktree,
  runCommand,
  runReleaseCheck,
  versionSelectedTargets,
} from "./runner.mjs";

const readStdout = ({ command, args }) =>
  execFileSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["inherit", "pipe", "pipe"],
  });

const hasFlag = ({ argv, flag }) => argv.includes(flag);

const readFlagValue = ({ argv, flag }) => {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === flag) {
      return argv[index + 1];
    }

    if (arg.startsWith(`${flag}=`)) {
      return arg.slice(flag.length + 1);
    }
  }

  return undefined;
};

const requireVersionPlan = ({ bump, version }) => {
  if (bump && version) {
    throw new Error("Use either --bump or --version, not both.");
  }

  if (!bump && !version) {
    throw new Error("release:prepare requires --bump patch|minor|major or --version <x.y.z>.");
  }
};

const assertOnBranch = () => {
  const branch = readStdout({
    command: "git",
    args: ["rev-parse", "--abbrev-ref", "HEAD"],
  }).trim();

  if (branch === "HEAD") {
    throw new Error("release:prepare must run from a branch so the release commit can be opened as a PR.");
  }

  if (branch === "main") {
    throw new Error("release:prepare should run from a release branch. Use `git switch -c release/vX.Y.Z` first.");
  }
};

const changedPaths = () =>
  readStdout({
    command: "git",
    args: ["status", "--porcelain=v1"],
  })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
    .map((path) => path.replace(/^"|"$/g, ""));

const argv = process.argv.slice(2);
const targetNames = parseTargetSelection(argv);
const bump = readFlagValue({ argv, flag: "--bump" });
const version = readFlagValue({ argv, flag: "--version" });
const commitMessageInput = readFlagValue({ argv, flag: "--commit-message" });
const noCommit = hasFlag({ argv, flag: "--no-commit" });

requireVersionPlan({ bump, version });
assertCleanWorktree({ purpose: "release:prepare" });
assertOnBranch();

const versionPlan = versionSelectedTargets({ targetNames, bump, version });
const releaseVersions = Array.from(new Set(versionPlan.values()));
const releaseName =
  releaseVersions.length === 1 ? releaseVersions[0] : releaseVersions.join(", ");
const commitMessage =
  commitMessageInput ?? `Prepare Voyd ${releaseName} release`;

const versionedPaths = changedPaths();
if (versionedPaths.length === 0) {
  throw new Error("Versioning did not change any files; refusing to prepare an empty release commit.");
}

runReleaseCheck({ targetNames });

runCommand({ command: "git", args: ["add", "--", ...versionedPaths] });

if (noCommit) {
  process.stdout.write("[release] Staged release changes. Commit them after review.\n");
} else {
  runCommand({ command: "git", args: ["commit", "-m", commitMessage] });
}
