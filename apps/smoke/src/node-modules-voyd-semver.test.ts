import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createSdk } from "@voyd/sdk";

const smokeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(smokeRoot, "..", "..");

describe("smoke: node_modules voyd_semver package resolution", () => {
  it("resolves package root and deep module imports from node_modules", async () => {
    const sdk = createSdk();
    const fixtureEntryPath = path.join(
      smokeRoot,
      "fixtures",
      "node-modules-voyd-semver",
      "main.voyd",
    );
    const tempRoot = await fs.mkdtemp(
      path.join(tmpdir(), "voyd-smoke-voyd-semver-"),
    );
    const srcDir = path.join(tempRoot, "src");
    const entryPath = path.join(srcDir, "main.voyd");
    const packageRoot = path.join(tempRoot, "node_modules", "voyd_semver");

    await fs.mkdir(srcDir, { recursive: true });
    await fs.copyFile(fixtureEntryPath, entryPath);
    await fs.cp(path.join(repoRoot, "packages", "voyd_semver"), packageRoot, {
      recursive: true,
    });

    try {
      const result = await sdk.compile({ entryPath });
      expect(result.success).toBe(true);
      if (!result.success) {
        throw new Error(
          result.diagnostics
            .map((diagnostic) => `${diagnostic.code} ${diagnostic.message}`)
            .join("\n"),
        );
      }

      const output = await result.run<number>({ entryName: "main" });
      expect(output).toBe(42);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});
