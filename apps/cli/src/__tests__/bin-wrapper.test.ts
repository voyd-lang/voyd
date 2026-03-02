import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testDir = fileURLToPath(new URL(".", import.meta.url));
const binSourcePath = resolve(testDir, "../../bin/voyd.js");

const createBinFixture = async (): Promise<{
  root: string;
  binPath: string;
}> => {
  const root = await mkdtemp(resolve(tmpdir(), "voyd-bin-wrapper-"));
  const binDir = resolve(root, "bin");
  const distDir = resolve(root, "dist");
  const binPath = resolve(binDir, "voyd.js");
  const distCliPath = resolve(distDir, "cli.js");

  await mkdir(binDir, { recursive: true });
  await mkdir(distDir, { recursive: true });

  await writeFile(binPath, await readFile(binSourcePath, "utf8"), "utf8");
  await writeFile(
    distCliPath,
    [
      "setTimeout(() => {",
      "  console.log(\"dist-ran\");",
      "}, 25);",
      "",
    ].join("\n"),
    "utf8",
  );

  return { root, binPath };
};

describe("voyd bin wrapper", () => {
  it("does not exit early when dist cli has async side effects", async () => {
    const fixture = await createBinFixture();

    try {
      const result = spawnSync(process.execPath, [fixture.binPath], {
        cwd: fixture.root,
        encoding: "utf8",
        env: {
          ...process.env,
          VOYD_DEV: "0",
          NODE_OPTIONS: "",
        },
        timeout: 10_000,
      });

      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

      expect(result.status).toBe(0);
      expect(output).toContain("dist-ran");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});
