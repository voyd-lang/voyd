import {
  assertNpmTargetsAlreadyPublished,
  assertCleanWorktree,
  parseSharedArgs,
  publishNpmTargets,
  runReleaseCheck,
  runVscodePublish,
  versionSelectedTargets,
} from "./runner.mjs";

const options = parseSharedArgs(process.argv.slice(2));

if (!options.allowDirty) {
  assertCleanWorktree();
}

if (
  options.targetNames.includes("voyd-vscode") &&
  !options.dryRun &&
  !process.env.VSCE_PAT
) {
  throw new Error(
    "VSCE_PAT is required to publish voyd-vscode. Set the environment variable or exclude voyd-vscode.",
  );
}

assertNpmTargetsAlreadyPublished({
  targetNames: options.targetNames,
  dryRun: options.dryRun,
});

const versionPlan = versionSelectedTargets(options);

runReleaseCheck({ targetNames: options.targetNames });
publishNpmTargets(options);

if (options.targetNames.includes("voyd-vscode")) {
  runVscodePublish({
    dryRun: options.dryRun,
    release: options.vscodeRelease,
    useExistingVersion: Boolean(versionPlan) || options.useExistingVscodeVersion,
  });
}
