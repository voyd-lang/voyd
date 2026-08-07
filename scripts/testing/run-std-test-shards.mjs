#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const stdSource = resolve(repositoryRoot, "packages/std/src");

export const parseShard = (value) => {
  const match = /^(\d+)\/(\d+)$/.exec(value ?? "1/1");
  if (!match) {
    throw new Error("std test shard must use format <index>/<count>");
  }
  const index = Number(match[1]);
  const count = Number(match[2]);
  if (index <= 0 || count <= 0 || index > count) {
    throw new Error("std test shard index must be within its shard count");
  }
  return { index, count };
};

export const partitionsForShard = (value) => {
  const shard = parseShard(value);
  if (shard.count === 1) return [{ index: 0, count: 1 }];

  // Hosted timings show that combining the odd quartiles produces a
  // disproportionately expensive compile. Keep them beside the smaller SDK
  // external groups, and pair the lighter even quartiles with the SDK base
  // group.
  if (shard.count === 2) {
    const indices = shard.index === 1 ? [1, 3] : [0, 2];
    return indices.map((index) => ({ index, count: 4 }));
  }

  return [{ index: shard.index - 1, count: shard.count }];
};

const run = () => {
  const partitions = partitionsForShard(process.env.VOYD_STD_TEST_SHARD);
  const timeoutMs = Number(
    process.env.VOYD_STD_TEST_PARTITION_TIMEOUT_MS ?? 420_000,
  );
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("VOYD_STD_TEST_PARTITION_TIMEOUT_MS must be positive");
  }

  for (const partition of partitions) {
    process.stdout.write(
      `\n[std partition ${partition.index + 1}/${partition.count}]\n`,
    );
    const result = spawnSync(
      process.execPath,
      [
        resolve(repositoryRoot, "scripts/voyd"),
        "test",
        stdSource,
        "--fail-empty-tests",
        `--shard=${partition.index + 1}/${partition.count}`,
      ],
      {
        cwd: repositoryRoot,
        env: { ...process.env, VOYD_USE_SRC: "1" },
        stdio: "inherit",
        timeout: timeoutMs,
      },
    );

    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
};

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  run();
}
