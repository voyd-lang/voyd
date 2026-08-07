#!/usr/bin/env node
import { spawnSync } from "node:child_process";
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

const run = () => {
  for (const groupName of groupsForShard(process.env.VOYD_SDK_TEST_SHARD)) {
    const group = groups[groupName];
    process.stdout.write(`\n[SDK test group ${groupName}]\n`);
    const result = spawnSync(
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
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
};

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  run();
}
