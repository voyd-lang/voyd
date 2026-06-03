import { execFileSync } from "node:child_process";
import fs from "node:fs";
import {
  parseTargetSelection,
  repoRoot,
} from "./manifest.mjs";
import {
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

const assertCleanWorktreeForReleaseCut = () => {
  const status = readStdout({
    command: "git",
    args: ["status", "--porcelain=v1"],
  }).trim();

  if (status.length > 0) {
    throw new Error("release:cut requires a clean worktree before versioning.");
  }
};

const assertOnMain = () => {
  const branch = readStdout({
    command: "git",
    args: ["rev-parse", "--abbrev-ref", "HEAD"],
  }).trim();

  if (branch !== "main") {
    throw new Error(`release:cut must run from main, currently on ${branch}.`);
  }
};

const assertUpToDate = () => {
  runCommand({ command: "git", args: ["fetch", "origin", "main", "--tags"] });

  const local = readStdout({ command: "git", args: ["rev-parse", "HEAD"] }).trim();
  const upstream = readStdout({ command: "git", args: ["rev-parse", "origin/main"] }).trim();

  if (local !== upstream) {
    throw new Error("release:cut requires local main to match origin/main.");
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

const requireVersionPlan = ({ bump, version }) => {
  if (bump && version) {
    throw new Error("Use either --bump or --version, not both.");
  }

  if (!bump && !version) {
    throw new Error("release:cut requires --bump patch|minor|major or --version <x.y.z>.");
  }
};

const workflowTargetsInput = ({ argv, targetNames }) =>
  hasFlag({ argv, flag: "--all" }) ? "--all" : targetNames.join(",");

const githubWorkflowArgs = ({
  targetInput,
  publish,
  npmTag,
  githubRelease,
  githubTag,
  githubReleaseTitle,
  githubReleaseNotes,
  githubReleaseNotesFile,
  vscodeRelease,
}) => {
  const args = [
    "workflow",
    "run",
    "release.yml",
    "--ref",
    "main",
    "--raw-field",
    `targets=${targetInput}`,
    "--raw-field",
    `dry_run=${publish ? "false" : "true"}`,
    "--raw-field",
    `npm_tag=${npmTag}`,
    "--raw-field",
    `github_release=${githubRelease ? "true" : "false"}`,
  ];

  if (vscodeRelease) {
    args.push("--raw-field", `vscode_release=${vscodeRelease}`);
  }

  if (githubTag) {
    args.push("--raw-field", `github_tag=${githubTag}`);
  }

  if (githubReleaseTitle) {
    args.push("--raw-field", `github_release_title=${githubReleaseTitle}`);
  }

  if (githubReleaseNotes) {
    args.push("--raw-field", `github_release_notes=${githubReleaseNotes}`);
  }

  if (githubReleaseNotesFile) {
    args.push("--raw-field", `github_release_notes_file=${githubReleaseNotesFile}`);
  }

  return args;
};

const argv = process.argv.slice(2);
const targetNames = parseTargetSelection(argv);
const bump = readFlagValue({ argv, flag: "--bump" });
const version = readFlagValue({ argv, flag: "--version" });
const npmTag = readFlagValue({ argv, flag: "--tag" }) ?? "latest";
const commitMessageInput = readFlagValue({ argv, flag: "--commit-message" });
const publish = hasFlag({ argv, flag: "--publish" });
const skipWorkflow = hasFlag({ argv, flag: "--skip-workflow" });
const githubRelease = hasFlag({ argv, flag: "--github-release" });
const githubTag = readFlagValue({ argv, flag: "--github-tag" });
const githubReleaseTitle = readFlagValue({ argv, flag: "--github-release-title" });
const githubReleaseNotes = readFlagValue({ argv, flag: "--github-release-notes" });
const githubReleaseNotesFile = readFlagValue({ argv, flag: "--github-release-notes-file" });
const vscodeRelease = readFlagValue({ argv, flag: "--vscode-release" });

requireVersionPlan({ bump, version });
if (githubReleaseNotesFile && !fs.existsSync(githubReleaseNotesFile)) {
  throw new Error(`GitHub release notes file does not exist: ${githubReleaseNotesFile}`);
}
assertCleanWorktreeForReleaseCut();
assertOnMain();
assertUpToDate();

const versionPlan = versionSelectedTargets({ targetNames, bump, version });
const releaseVersions = Array.from(new Set(versionPlan.values()));
const releaseName =
  releaseVersions.length === 1 ? releaseVersions[0] : releaseVersions.join(", ");
const commitMessage =
  commitMessageInput ?? `Prepare Voyd ${releaseName} release`;

const versionedPaths = changedPaths();
if (versionedPaths.length === 0) {
  throw new Error("Versioning did not change any files; refusing to create an empty release commit.");
}

runReleaseCheck({ targetNames });

runCommand({ command: "git", args: ["add", "--", ...versionedPaths] });
runCommand({ command: "git", args: ["commit", "-m", commitMessage] });
runCommand({ command: "git", args: ["push", "origin", "main"] });

if (skipWorkflow) {
  process.stdout.write("[release] Skipped GitHub release workflow dispatch.\n");
} else {
  runCommand({
    command: "gh",
    args: githubWorkflowArgs({
      targetInput: workflowTargetsInput({ argv, targetNames }),
      publish,
      npmTag,
      githubRelease,
      githubTag,
      githubReleaseTitle,
      githubReleaseNotes,
      githubReleaseNotesFile,
      vscodeRelease,
    }),
  });
}
