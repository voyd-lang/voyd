import {
  resolveWorkspaceNameFromEnv,
  runReleaseCheck,
  validatePrecompiledStdReleaseTargets,
} from "./runner.mjs";

if (process.env.VOYD_RELEASE_SKIP_PUBLISH_CHECK === "1") {
  process.exit(0);
}

const workspace = resolveWorkspaceNameFromEnv();
validatePrecompiledStdReleaseTargets([workspace]);
runReleaseCheck({ targetNames: [workspace] });
