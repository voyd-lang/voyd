import {
  assertCleanWorktree,
  parseSharedArgs,
  versionSelectedTargets,
} from "./runner.mjs";

const options = parseSharedArgs(process.argv.slice(2));

if (!options.bump && !options.version) {
  throw new Error("release:version requires --bump patch|minor|major or --version <x.y.z>.");
}

if (!options.allowDirty) {
  assertCleanWorktree();
}

versionSelectedTargets(options);
