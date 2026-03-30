import {
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

const versionPlan = versionSelectedTargets(options);

runReleaseCheck({ targetNames: options.targetNames });
publishNpmTargets(options);

if (options.targetNames.includes("voyd-vscode")) {
  runVscodePublish({
    dryRun: options.dryRun,
    release: options.vscodeRelease,
    useExistingVersion: Boolean(versionPlan),
  });
}
