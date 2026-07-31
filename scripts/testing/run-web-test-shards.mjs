import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { relative, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../..");
const webSource = resolve(repoRoot, "packages/web/src");
const testFiles = findTestFiles(webSource)
  .map((file) => relative(repoRoot, file))
  .sort();
const shardTimeoutMs = Number(
  process.env.VOYD_WEB_TEST_SHARD_TIMEOUT_MS ?? 600_000,
);

if (testFiles.length === 0) {
  throw new Error("No packages/web/src/**/*.test.voyd files found");
}
if (!Number.isFinite(shardTimeoutMs) || shardTimeoutMs <= 0) {
  throw new Error("VOYD_WEB_TEST_SHARD_TIMEOUT_MS must be a positive number");
}

process.stdout.write(`Discovered ${testFiles.length} web test-file shards.\n`);

for (const [index, testFile] of testFiles.entries()) {
  process.stdout.write(
    `\n[web shard ${index + 1}/${testFiles.length}] ${testFile}\n`,
  );
  const result = spawnSync(
    process.execPath,
    [resolve(repoRoot, "scripts/voyd"), "test", testFile, "--fail-empty-tests"],
    {
      cwd: repoRoot,
      env: { ...process.env, VOYD_USE_SRC: "1" },
      stdio: "inherit",
      timeout: shardTimeoutMs,
    },
  );

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

process.stdout.write(
  `\nCompleted ${testFiles.length} web test-file shards successfully.\n`,
);

function findTestFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return findTestFiles(path);
    return entry.isFile() && entry.name.endsWith(".test.voyd") ? [path] : [];
  });
}
