import { describe, it, expect } from "vitest";
import { resolveSrc } from "../resolve-src.js";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

describe("resolveSrc", () => {
  it("throws when directory lacks index.voyd", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "voyd-test-"));
    try {
      await expect(resolveSrc(dir)).rejects.toThrow(/index\.voyd/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("resolves index file in directory", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "voyd-test-"));
    const indexFile = path.join(dir, "index.voyd");
    await writeFile(indexFile, "");
    try {
      const info = await resolveSrc(dir);
      expect(info).toStrictEqual({
        indexPath: indexFile,
        srcRootPath: dir,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
