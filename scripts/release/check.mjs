import { parseSharedArgs, runReleaseCheck } from "./runner.mjs";

const options = parseSharedArgs(process.argv.slice(2));
runReleaseCheck({ targetNames: options.targetNames });
