import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createSdk } from "@voyd/sdk";

const smokeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureSrcRoot = path.join(smokeRoot, "fixtures", "source-level-pkg", "src");

describe("smoke: source-level pkg definitions", () => {
  it("keeps inline module scope for modules named pkg", async () => {
    const sdk = createSdk();
    const entryPath = path.join(fixtureSrcRoot, "inline_pkg_module.voyd");

    const result = await sdk.compile({ entryPath });
    if (!result.success) {
      throw new Error(
        result.diagnostics
          .map((diagnostic) => `${diagnostic.code} ${diagnostic.message}`)
          .join("\n"),
      );
    }
    expect(result.success).toBe(true);

    const output = await result.run<number>({ entryName: "main" });
    expect(output).toBe(42);
  });

  it("allows consuming subpackage exports through nested pkg.voyd", async () => {
    const sdk = createSdk();
    const entryPath = path.join(fixtureSrcRoot, "main.voyd");

    const result = await sdk.compile({ entryPath });
    if (!result.success) {
      throw new Error(
        result.diagnostics
          .map((diagnostic) => `${diagnostic.code} ${diagnostic.message}`)
          .join("\n"),
      );
    }
    expect(result.success).toBe(true);

    const output = await result.run<number>({ entryName: "main" });
    expect(output).toBe(41);
  });

  it("rejects direct imports from subpackage internals", async () => {
    const sdk = createSdk();
    const entryPath = path.join(fixtureSrcRoot, "fails_non_export.voyd");

    const result = await sdk.compile({ entryPath });
    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("expected compile to fail");
    }

    const message = result.diagnostics
      .map((diagnostic) => `${diagnostic.code} ${diagnostic.message}`)
      .join("\n");
    expect(message).toMatch(/BD0001/);
    expect(message).toMatch(/visibility: package/);
    expect(message).toMatch(/internal_only/);
  });

  it("rejects non-api member access across source subpackages", async () => {
    const sdk = createSdk();
    const entryPath = path.join(fixtureSrcRoot, "fails_non_api_member.voyd");

    const result = await sdk.compile({ entryPath });
    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("expected compile to fail");
    }

    const message = result.diagnostics
      .map((diagnostic) => `${diagnostic.code} ${diagnostic.message}`)
      .join("\n");
    expect(message).toMatch(/TY0009/);
    expect(message).toMatch(/hidden/);
  });
});
