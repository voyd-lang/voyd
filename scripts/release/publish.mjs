import { execFileSync } from "node:child_process";
import fs from "node:fs";
import {
  getTarget,
  parseTargetSelection,
  readTargetPackageJson,
  repoRoot,
} from "./manifest.mjs";
import {
  assertCleanWorktree,
  assertNpmTargetsAlreadyPublished,
} from "./runner.mjs";

const readStdout = ({ command, args }) =>
  execFileSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["inherit", "pipe", "pipe"],
  });

const runCommand = ({ command, args }) => {
  const printable = [command, ...args].join(" ");
  process.stdout.write(`\n[release] ${printable}\n`);
  execFileSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
  });
};

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

const assertOnMain = () => {
  const branch = readStdout({
    command: "git",
    args: ["rev-parse", "--abbrev-ref", "HEAD"],
  }).trim();

  if (branch !== "main") {
    throw new Error(`release:publish must run from main, currently on ${branch}.`);
  }
};

const assertUpToDate = () => {
  runCommand({ command: "git", args: ["fetch", "origin", "main", "--tags"] });

  const local = readStdout({ command: "git", args: ["rev-parse", "HEAD"] }).trim();
  const upstream = readStdout({ command: "git", args: ["rev-parse", "origin/main"] }).trim();

  if (local !== upstream) {
    throw new Error("release:publish requires local main to match origin/main.");
  }
};

const inferReleaseVersion = (targetNames) => {
  const versions = Array.from(
    new Set(
      targetNames.map((targetName) => {
        getTarget(targetName);
        return readTargetPackageJson(targetName).version;
      }),
    ),
  );

  if (versions.length !== 1) {
    return null;
  }

  return versions[0];
};

const workflowTargetsInput = ({ argv, targetNames }) =>
  hasFlag({ argv, flag: "--all" }) ? "--all" : targetNames.join(",");

const assertVscodeSecretConfigured = ({ targetNames, dryRun }) => {
  if (dryRun || !targetNames.includes("voyd-vscode")) {
    return;
  }

  const secretNames = readStdout({
    command: "gh",
    args: ["secret", "list", "--app", "actions", "-R", "voyd-lang/voyd"],
  })
    .split("\n")
    .map((line) => line.trim().split(/\s+/)[0])
    .filter(Boolean);

  if (!secretNames.includes("VSCE_PAT")) {
    throw new Error(
      "VSCE_PAT is required to publish voyd-vscode. Add it as a GitHub Actions secret or exclude voyd-vscode.",
    );
  }
};

const buildWorkflowArgs = ({
  targetInput,
  dryRun,
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
    `dry_run=${dryRun ? "true" : "false"}`,
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
const dryRun = hasFlag({ argv, flag: "--dry-run" });
const npmTag = readFlagValue({ argv, flag: "--tag" }) ?? "latest";
const githubTag = readFlagValue({ argv, flag: "--github-tag" });
const githubReleaseTitle = readFlagValue({ argv, flag: "--github-release-title" });
const githubReleaseNotes = readFlagValue({ argv, flag: "--github-release-notes" });
const explicitNotesFile =
  readFlagValue({ argv, flag: "--github-release-notes-file" }) ??
  readFlagValue({ argv, flag: "--notes-file" });
const vscodeRelease = readFlagValue({ argv, flag: "--vscode-release" });
const githubRelease = !dryRun && !hasFlag({ argv, flag: "--skip-github-release" });
const releaseVersion = inferReleaseVersion(targetNames);
const defaultNotesFile = releaseVersion
  ? `docs/release/v${releaseVersion}-notes.md`
  : undefined;
const githubReleaseNotesFile =
  explicitNotesFile ??
  (defaultNotesFile && fs.existsSync(defaultNotesFile) ? defaultNotesFile : undefined);

assertCleanWorktree({ purpose: "release:publish" });
assertOnMain();
assertUpToDate();

if (githubReleaseNotesFile && !fs.existsSync(githubReleaseNotesFile)) {
  throw new Error(`GitHub release notes file does not exist: ${githubReleaseNotesFile}`);
}

assertVscodeSecretConfigured({ targetNames, dryRun });
assertNpmTargetsAlreadyPublished({ targetNames, dryRun });

runCommand({
  command: "gh",
  args: buildWorkflowArgs({
    targetInput: workflowTargetsInput({ argv, targetNames }),
    dryRun,
    npmTag,
    githubRelease,
    githubTag,
    githubReleaseTitle,
    githubReleaseNotes,
    githubReleaseNotesFile,
    vscodeRelease,
  }),
});

process.stdout.write(
  "\n[release] Dispatched release.yml. Watch it with: gh run list --workflow release.yml --limit 5\n",
);
