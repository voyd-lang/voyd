import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = resolve(import.meta.dirname, "../..");
const webSource = resolve(repoRoot, "packages/web/src");
const defaultPartitionCount = 8;
const isMain =
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) run();

export function parsePartitionArgs(args) {
  if (args.length !== 2) {
    throw new Error(
      "Partitioning requires --partition-index and --partition-count",
    );
  }

  const values = Object.fromEntries(
    args.map((argument) => {
      const match = /^--(partition-index|partition-count)=(.+)$/.exec(argument);
      if (!match) throw new Error(`Unknown web shard argument: ${argument}`);
      return [match[1], Number(match[2])];
    }),
  );
  const index = values["partition-index"];
  const count = values["partition-count"];

  if (!Number.isInteger(count) || count <= 0) {
    throw new Error("--partition-count must be a positive integer");
  }
  if (!Number.isInteger(index) || index < 0 || index >= count) {
    throw new Error(
      "--partition-index must be an integer from zero to partition-count - 1",
    );
  }
  return { index, count };
}

export function partitionsForArgs(args) {
  if (args.length > 0) return [parsePartitionArgs(args)];
  return Array.from({ length: defaultPartitionCount }, (_value, index) => ({
    index,
    count: defaultPartitionCount,
  }));
}

function run() {
  const partitions = partitionsForArgs(process.argv.slice(2));
  const shardTimeoutMs = Number(
    process.env.VOYD_WEB_TEST_SHARD_TIMEOUT_MS ?? 600_000,
  );

  if (!Number.isFinite(shardTimeoutMs) || shardTimeoutMs <= 0) {
    throw new Error("VOYD_WEB_TEST_SHARD_TIMEOUT_MS must be a positive number");
  }

  process.stdout.write(
    `Running ${partitions.length} compile-level web test partition${partitions.length === 1 ? "" : "s"}.\n`,
  );

  for (const partition of partitions) {
    process.stdout.write(
      `\n[web partition ${partition.index + 1}/${partition.count}]\n`,
    );
    const result = spawnSync(
      process.execPath,
      [
        resolve(repoRoot, "scripts/voyd"),
        "test",
        webSource,
        `--shard=${partition.index + 1}/${partition.count}`,
        "--fail-empty-tests",
      ],
      {
        cwd: repoRoot,
        env: { ...process.env, VOYD_USE_SRC: "1" },
        stdio: "inherit",
        timeout: shardTimeoutMs,
      },
    );

    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }

  process.stdout.write(
    `\nCompleted ${partitions.length} web test partition${partitions.length === 1 ? "" : "s"} successfully.\n`,
  );
}
