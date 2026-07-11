import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const distCliPath = resolve(import.meta.dirname, "../../dist/cli.js");
const timeoutMs = 60_000;

describe("distributed CLI smoke", () => {
  let root: string;
  let entryPath: string;
  let testRoot: string;

  beforeAll(async () => {
    root = await mkdtemp(resolve(tmpdir(), "voyd-cli-dist-smoke-"));
    const srcRoot = resolve(root, "src");
    testRoot = resolve(root, "test");
    entryPath = resolve(srcRoot, "main.voyd");
    await mkdir(srcRoot, { recursive: true });
    await mkdir(testRoot, { recursive: true });
    await writeFile(entryPath, "pub fn main() -> i32\n  42\n");
    await writeFile(
      resolve(testRoot, "main.test.voyd"),
      [
        "use std::test::assertions::all",
        "",
        'test "distributed test command runs":',
        "  assert(40 + 2 == 42)",
        "",
      ].join("\n"),
    );
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("starts the packaged CLI", () => {
    const result = runCli(root, ["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage:");
  });

  it("compiles and runs through the packaged CLI", () => {
    const compile = runCli(root, ["--emit-ir-ast", entryPath]);
    expect(`${compile.stdout}${compile.stderr}`).not.toContain(
      "Unable to resolve module",
    );
    expect(compile.status).toBe(0);

    const run = runCli(root, ["--run", entryPath]);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("42");
  });

  it("runs Voyd tests through the packaged CLI", () => {
    const result = runCli(root, ["test", testRoot]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("passed 1, failed 0, skipped 0");
  });
});

const runCli = (cwd: string, args: string[]) =>
  spawnSync(process.execPath, [distCliPath, ...args], {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
  });
