import { orderedTargetNames } from "./manifest.mjs";
import { describeTargets } from "./runner.mjs";

const targets = describeTargets(orderedTargetNames);

targets.forEach(({ targetName, kind, version, cwd, description }) => {
  process.stdout.write(`${targetName}\n`);
  process.stdout.write(`  kind: ${kind}\n`);
  process.stdout.write(`  version: ${version}\n`);
  process.stdout.write(`  path: ${cwd}\n`);
  process.stdout.write(`  ${description}\n\n`);
});
