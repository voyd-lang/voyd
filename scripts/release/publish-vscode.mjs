import {
  assertCleanWorktree,
  runReleaseCheck,
  runVscodePublish,
} from "./runner.mjs";

const args = process.argv.slice(2);
const releaseFlagIndex = args.findIndex(
  (arg) => arg === "--release" || arg.startsWith("--release="),
);

let release;
if (releaseFlagIndex >= 0) {
  const arg = args[releaseFlagIndex];
  release =
    arg === "--release"
      ? args[releaseFlagIndex + 1]
      : arg.split("=")[1];
}

const dryRun = args.includes("--dry-run");
const allowDirty = args.includes("--allow-dirty");

if (!allowDirty) {
  assertCleanWorktree();
}

if (process.env.VOYD_RELEASE_SKIP_PUBLISH_CHECK !== "1") {
  runReleaseCheck({ targetNames: ["voyd-vscode"] });
}

runVscodePublish({ dryRun, release });
