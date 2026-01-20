import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSdk } from "@voyd/sdk";

describe("node sdk", () => {
  it("compiles and runs a source module", async () => {
    const sdk = createSdk();
    const result = await sdk.compile({
      source: `pub fn main() -> i32
  42
`,
    });

    const output = await result.run<number>({ entryName: "main" });
    expect(output).toBe(42);
  });

  it("compiles when entryPath is relative with subdirectories", async () => {
    const sdk = createSdk();
    const repoRoot = process.cwd();
    const tempRoot = await fs.mkdtemp(path.join(repoRoot, ".tmp-voyd-sdk-"));
    const srcDir = path.join(tempRoot, "src");
    const entryPath = path.join(srcDir, "index.voyd");
    const relativeEntryPath = path.relative(repoRoot, entryPath);
    await fs.mkdir(srcDir, { recursive: true });
    await fs.writeFile(
      entryPath,
      `pub fn main() -> i32
  7
`
    );

    try {
      const result = await sdk.compile({ entryPath: relativeEntryPath });
      const output = await result.run<number>({ entryName: "main" });
      expect(output).toBe(7);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});
