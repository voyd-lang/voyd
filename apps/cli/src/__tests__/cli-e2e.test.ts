import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const testDir = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(testDir, "../../../../");
const tsxPath = resolve(repoRoot, "node_modules/.bin/tsx");

const createFixture = async (): Promise<string> => {
  const root = await mkdtemp(resolve(tmpdir(), "voyd-cli-e2e-"));
  const testRoot = resolve(root, "test");
  await mkdir(testRoot, { recursive: true });
  await writeFile(
    resolve(testRoot, "default-root.voyd"),
    [
      "use std::test::assertions::all",
      "",
      "test \"default test root\":",
      "  assert(true)",
      "",
    ].join("\n")
  );
  return root;
};

const cliPath = resolve(repoRoot, "apps/cli/src/cli-dev.ts");

const runCliTest = (root: string) =>
  spawnSync(
    tsxPath,
    ["--conditions=development", cliPath, "test"],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env },
      timeout: 30000,
    }
  );

describe("voyd cli test discovery", () => {
  it(
    "defaults test root to repo root when no path is provided",
    async () => {
      if (!existsSync(tsxPath)) {
        throw new Error(`Missing tsx binary at ${tsxPath}`);
      }

    const root = await createFixture();
    try {
      const result = runCliTest(root);
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

      if (result.status !== 0) {
        throw new Error(`voyd test failed: ${output}`);
      }

      expect(output).toContain("passed 1, failed 0, skipped 0");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
    },
    30000
  );
});
