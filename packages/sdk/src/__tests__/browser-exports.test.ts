import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("sdk exports", () => {
  it("does not expose browser source entry via development exports", async () => {
    const packageJsonPath = fileURLToPath(
      new URL("../../package.json", import.meta.url)
    );
    const raw = await fs.readFile(packageJsonPath, "utf8");
    const json = JSON.parse(raw) as {
      exports?: Record<string, any>;
    };

    expect(json.exports?.["./browser"]?.development).toBe(
      "./dist/browser/index.js"
    );
  });
});
