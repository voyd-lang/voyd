import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createSdk, type CompileResult } from "@voyd-lang/sdk";
import { createVoydHost } from "@voyd-lang/sdk/js-host";

const fixtureEntryPath = path.join(
  import.meta.dirname,
  "..",
  "fixtures",
  "std-fs.voyd",
);

const expectCompileSuccess = (
  result: CompileResult,
): Extract<CompileResult, { success: true }> => {
  if (!result.success) {
    throw new Error(
      result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"),
    );
  }
  expect(result.success).toBe(true);
  return result;
};

describe("integration: std fs", () => {
  const tempRoots: string[] = [];
  let compiled: Extract<CompileResult, { success: true }>;

  beforeAll(async () => {
    const sdk = createSdk();
    compiled = expectCompileSuccess(
      await sdk.compile({ entryPath: fixtureEntryPath }),
    );
  });

  afterEach(async () => {
    delete process.env.VOYD_STD_FS_REMOVE_PATH;
    await Promise.all(
      tempRoots
        .splice(0)
        .map((root) => fs.rm(root, { recursive: true, force: true })),
    );
  });

  it("removes supported paths and preserves directory targets", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "voyd-std-fs-smoke-"),
    );
    tempRoots.push(tempRoot);
    const filePath = path.join(tempRoot, "old.txt");
    const directoryPath = path.join(tempRoot, "empty");
    const targetPath = path.join(tempRoot, "target");
    const targetFilePath = path.join(targetPath, "keep.txt");
    const symlinkPath = path.join(tempRoot, "target-link");
    await fs.writeFile(filePath, "remove me");
    await fs.mkdir(directoryPath);
    await fs.mkdir(targetPath);
    await fs.writeFile(targetFilePath, "keep me");
    await fs.symlink(
      targetPath,
      symlinkPath,
      process.platform === "win32" ? "junction" : "dir",
    );

    const host = await createVoydHost({
      wasm: compiled.wasm,
      defaultAdapters: { runtime: "node" },
    });
    const removePath = async (target: string): Promise<number> => {
      process.env.VOYD_STD_FS_REMOVE_PATH = target;
      return host.run<number>("remove_path_from_env");
    };

    await expect(removePath(filePath)).resolves.toBe(1);
    await expect(removePath(directoryPath)).resolves.toBe(1);
    await expect(removePath(symlinkPath)).resolves.toBe(1);
    await expect(fs.access(filePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(directoryPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.access(symlinkPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.readFile(targetFilePath, "utf8")).resolves.toBe("keep me");

    await expect(removePath(targetPath)).resolves.not.toBe(1);
    await expect(removePath(filePath)).resolves.not.toBe(1);
    await expect(fs.readFile(targetFilePath, "utf8")).resolves.toBe("keep me");
  });
});
