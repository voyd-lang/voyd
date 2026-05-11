import { execFileSync } from "node:child_process";
import fs from "node:fs";
import {
  getTarget,
  parseTargetSelection,
  readTargetPackageJson,
  repoRoot,
} from "./manifest.mjs";
import { runCommand } from "./runner.mjs";

const readStdout = ({ command, args }) =>
  execFileSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["inherit", "pipe", "pipe"],
  });

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

const hasFlag = ({ argv, flag }) => argv.includes(flag);

const inferVersion = (targetNames) => {
  const versions = Array.from(
    new Set(
      targetNames.map((targetName) => {
        getTarget(targetName);
        return readTargetPackageJson(targetName).version;
      }),
    ),
  );

  if (versions.length !== 1) {
    throw new Error(
      `Cannot infer a GitHub release tag from mixed target versions: ${versions.join(", ")}. Pass --github-tag explicitly.`,
    );
  }

  return versions[0];
};

const tagExists = (tagName) => {
  try {
    readStdout({
      command: "git",
      args: ["rev-parse", "--quiet", "--verify", `refs/tags/${tagName}`],
    });
    return true;
  } catch {
    return false;
  }
};

const buildReleaseArgs = ({ tagName, title, notes, notesFile }) => {
  const args = ["release", "create", tagName, "--title", title];

  if (notesFile) {
    args.push("--notes-file", notesFile);
    return args;
  }

  if (notes) {
    args.push("--notes", notes);
    return args;
  }

  args.push("--generate-notes");
  return args;
};

const argv = process.argv.slice(2);
const targetNames = parseTargetSelection(argv);
const version = inferVersion(targetNames);
const tagName = readFlagValue({ argv, flag: "--github-tag" }) ?? `v${version}`;
const titleVersion = tagName.startsWith("v") ? tagName.slice(1) : version;
const title = readFlagValue({ argv, flag: "--title" }) ?? `Voyd ${titleVersion}`;
const notes = readFlagValue({ argv, flag: "--notes" });
const notesFile = readFlagValue({ argv, flag: "--notes-file" });
const dryRun = hasFlag({ argv, flag: "--dry-run" });
const createTag = hasFlag({ argv, flag: "--create-tag" });

if (notesFile && !fs.existsSync(notesFile)) {
  throw new Error(`GitHub release notes file does not exist: ${notesFile}`);
}

if (!tagExists(tagName)) {
  if (!createTag) {
    throw new Error(
      `Git tag ${tagName} does not exist. Create it first or pass --create-tag.`,
    );
  }

  if (dryRun) {
    process.stdout.write(`[release] Would create and push git tag ${tagName}\n`);
  } else {
    runCommand({ command: "git", args: ["tag", tagName] });
    runCommand({ command: "git", args: ["push", "origin", tagName] });
  }
}

const releaseArgs = buildReleaseArgs({ tagName, title, notes, notesFile });

if (dryRun) {
  process.stdout.write(`[release] Would run gh ${releaseArgs.join(" ")}\n`);
} else {
  runCommand({ command: "gh", args: releaseArgs });
}
