import { resolveWorkspaceNameFromEnv, runReleaseCheck } from "./runner.mjs";

if (process.env.VOYD_RELEASE_SKIP_PUBLISH_CHECK === "1") {
  process.exit(0);
}

const workspace = resolveWorkspaceNameFromEnv();
runReleaseCheck({ targetNames: [workspace] });
