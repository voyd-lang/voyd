import {
  assertCleanWorktree,
  parseSharedArgs,
  publishNpmTargets,
  runReleaseCheck,
  runVscodePublish,
} from "./runner.mjs";

const options = parseSharedArgs(process.argv.slice(2));

if (!options.allowDirty) {
  assertCleanWorktree();
}

runReleaseCheck({ targetNames: options.targetNames });
publishNpmTargets(options);

if (options.targetNames.includes("voyd-vscode")) {
  runVscodePublish({
    dryRun: options.dryRun,
    release: options.vscodeRelease,
  });
}
