#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const sdkRoot = path.join(repositoryRoot, "packages/sdk");
const vitestPath = path.join(repositoryRoot, "node_modules/vitest/vitest.mjs");

const groups = {
  base: {
    files: ["src"],
    pattern: "^(?!.*\\[external-[ab]\\])",
  },
  "external-a": {
    files: ["src/__tests__/sdk-node.test.ts"],
    pattern: "\\[external-a\\]",
  },
  "external-b": {
    files: ["src/__tests__/sdk-node.test.ts"],
    pattern: "\\[external-b\\]",
  },
};

export const parseShard = (value) => {
  const match = /^(\d+)\/(\d+)$/.exec(value ?? "1/1");
  if (!match) {
    throw new Error("SDK test shard must use format <index>/<count>");
  }
  const index = Number(match[1]);
  const count = Number(match[2]);
  if (index <= 0 || count <= 0 || index > count) {
    throw new Error("SDK test shard index must be within its shard count");
  }
  return { index, count };
};

export const groupsForShard = (value) => {
  const shard = parseShard(value);
  if (shard.count === 1) return ["base", "external-a", "external-b"];
  if (shard.count === 2) {
    return shard.index === 1 ? ["base"] : ["external-a", "external-b"];
  }
  throw new Error("SDK tests support one or two shards");
};

export const executionBatches = ({ shardValue, isCi }) => {
  const selectedGroups = groupsForShard(shardValue);
  if (!isCi && shardValue === undefined) {
    return [["base"], ["external-a", "external-b"]];
  }
  return [selectedGroups];
};

const run = async () => {
  const shardValue = process.env.VOYD_SDK_TEST_SHARD;
  const batches = executionBatches({
    shardValue,
    isCi: process.env.CI !== undefined,
  });
  const statuses = await Promise.all(batches.map(runGroupSequence));
  process.exitCode = statuses.every((status) => status === 0) ? 0 : 1;
};

const runGroupSequence = async (groupNames) => {
  for (const groupName of groupNames) {
    const status = await runGroup(groupName);
    if (status !== 0) return status;
  }
  return 0;
};

const runGroup = (groupName) => {
  const group = groups[groupName];
  process.stdout.write(`\n[SDK test group ${groupName}]\n`);
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        vitestPath,
        "run",
        "--config",
        "../../vitest.config.ts",
        "--testTimeout",
        "30000",
        ...group.files,
        "--testNamePattern",
        group.pattern,
      ],
      { cwd: sdkRoot, env: process.env, stdio: "inherit" },
    );
    child.on("error", reject);
    child.on("exit", (status) => resolve(status ?? 1));
  });
};

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  await run();
}
