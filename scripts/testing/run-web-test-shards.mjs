import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = resolve(import.meta.dirname, "../..");
const webSource = resolve(repoRoot, "packages/web/src");
const isMain =
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) run();

export function selectPartition(testFiles, partition) {
  if (partition.count === 1) return testFiles;
  return testFiles.filter(
    (_testFile, index) => index % partition.count === partition.index,
  );
}

export function parsePartitionArgs(args) {
  if (args.length === 0) return { index: 0, count: 1 };
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

function run() {
  const allTestFiles = findTestFiles(webSource)
    .map((file) => relative(repoRoot, file))
    .sort();
  const partition = parsePartitionArgs(process.argv.slice(2));
  const testFiles = selectPartition(allTestFiles, partition);
  const shardTimeoutMs = Number(
    process.env.VOYD_WEB_TEST_SHARD_TIMEOUT_MS ?? 600_000,
  );

  if (allTestFiles.length === 0) {
    throw new Error("No packages/web/src/**/*.test.voyd files found");
  }
  if (testFiles.length === 0) {
    throw new Error(
      `Web test partition ${partition.index} of ${partition.count} is empty`,
    );
  }
  if (!Number.isFinite(shardTimeoutMs) || shardTimeoutMs <= 0) {
    throw new Error("VOYD_WEB_TEST_SHARD_TIMEOUT_MS must be a positive number");
  }

  process.stdout.write(
    `Discovered ${allTestFiles.length} web test-file shards; running ${testFiles.length} in partition ${partition.index + 1}/${partition.count}.\n`,
  );

  for (const [index, testFile] of testFiles.entries()) {
    process.stdout.write(
      `\n[web shard ${index + 1}/${testFiles.length}] ${testFile}\n`,
    );
    const result = spawnSync(
      process.execPath,
      [
        resolve(repoRoot, "scripts/voyd"),
        "test",
        testFile,
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
    `\nCompleted ${testFiles.length} web test-file shards successfully.\n`,
  );
}

function findTestFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return findTestFiles(path);
    return entry.isFile() && entry.name.endsWith(".test.voyd") ? [path] : [];
  });
}
