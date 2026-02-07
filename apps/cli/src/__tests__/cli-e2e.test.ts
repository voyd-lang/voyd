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

const createNodeModulesFixture = async (): Promise<string> => {
  const root = await mkdtemp(resolve(tmpdir(), "voyd-cli-node-modules-"));
  const srcRoot = resolve(root, "src");
  const packageSrcRoot = resolve(root, "node_modules", "my_pkg", "src");
  await mkdir(srcRoot, { recursive: true });
  await mkdir(packageSrcRoot, { recursive: true });

  await writeFile(
    resolve(srcRoot, "main.voyd"),
    [
      "use pkg::my_pkg::all",
      "",
      "pub fn main() -> i32",
      "  plus_one(41)",
      "",
    ].join("\n")
  );
  await writeFile(
    resolve(packageSrcRoot, "pkg.voyd"),
    [
      "pub use src::math::plus_one",
      "",
    ].join("\n")
  );
  await writeFile(
    resolve(packageSrcRoot, "math.voyd"),
    [
      "pub fn plus_one(value: i32) -> i32",
      "  value + 1",
      "",
    ].join("\n")
  );

  return root;
};

const createNodeModulesTestFixture = async (): Promise<string> => {
  const root = await mkdtemp(resolve(tmpdir(), "voyd-cli-test-node-modules-"));
  const testRoot = resolve(root, "test");
  const packageSrcRoot = resolve(root, "node_modules", "my_pkg", "src");
  await mkdir(testRoot, { recursive: true });
  await mkdir(packageSrcRoot, { recursive: true });

  await writeFile(
    resolve(testRoot, "uses_pkg.voyd"),
    [
      "use std::test::assertions::all",
      "use pkg::my_pkg::all",
      "",
      "test \"imports package in voyd test\":",
      "  assert(plus_one(1) == 2)",
      "",
    ].join("\n"),
  );
  await writeFile(
    resolve(packageSrcRoot, "pkg.voyd"),
    [
      "pub use src::math::plus_one",
      "",
    ].join("\n"),
  );
  await writeFile(
    resolve(packageSrcRoot, "math.voyd"),
    [
      "pub fn plus_one(value: i32) -> i32",
      "  value + 1",
      "",
    ].join("\n"),
  );

  return root;
};

const cliPath = resolve(repoRoot, "apps/cli/src/cli-dev.ts");

const runCli = (root: string, args: string[]) =>
  spawnSync(
    tsxPath,
    ["--conditions=development", cliPath, ...args],
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
        const result = runCli(root, ["test"]);
        const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

        if (result.status !== 0) {
          throw new Error(`voyd test failed: ${output}`);
        }

        expect(output).toContain("passed 1, failed 0, skipped 0");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    30000,
  );
});

describe("voyd cli package resolution", () => {
  it(
    "defaults package lookup to node_modules",
    async () => {
      if (!existsSync(tsxPath)) {
        throw new Error(`Missing tsx binary at ${tsxPath}`);
      }

      const root = await createNodeModulesFixture();
      try {
        const result = runCli(root, ["--emit-ir-ast"]);
        const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

        if (result.status !== 0) {
          throw new Error(`voyd compile failed: ${output}`);
        }

        expect(output).not.toContain("Unable to resolve module");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    30000,
  );

  it(
    "defaults voyd test package lookup to node_modules",
    async () => {
      if (!existsSync(tsxPath)) {
        throw new Error(`Missing tsx binary at ${tsxPath}`);
      }

      const root = await createNodeModulesTestFixture();
      try {
        const result = runCli(root, ["test"]);
        const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

        if (result.status !== 0) {
          throw new Error(`voyd test failed: ${output}`);
        }

        expect(output).toContain("passed 1, failed 0, skipped 0");
        expect(output).not.toContain("Unable to resolve module");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    30000,
  );
});
