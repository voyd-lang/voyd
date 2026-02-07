import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSdk } from "@voyd/sdk";

describe("smoke: exported effects annotations", () => {
  it("allows omitting pure effect annotations on exported api methods", async () => {
    const sdk = createSdk();
    const entryPath = path.join(
      process.cwd(),
      "fixtures",
      "effects-exports-pure",
      "pkg.voyd",
    );
    const result = await sdk.compile({ entryPath });
    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
    }
    const output = await result.run<number>({ entryName: "main" });
    expect(output).toBe(7);
  });

  it("accepts explicitly annotated effectful exported api methods", async () => {
    const sdk = createSdk();
    const entryPath = path.join(
      process.cwd(),
      "fixtures",
      "effects-exports-annotated",
      "pkg.voyd",
    );
    const result = await sdk.compile({ entryPath });
    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
    }
  });

  it("emits a helpful diagnostic for missing effect annotations on exported api methods", async () => {
    const sdk = createSdk();
    const entryPath = path.join(
      process.cwd(),
      "fixtures",
      "effects-exports-missing-annotation",
      "pkg.voyd",
    );
    const result = await sdk.compile({ entryPath });
    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("expected compile to fail");
    }

    const message = result.diagnostics
      .map((diagnostic) => `${diagnostic.code} ${diagnostic.message}`)
      .join("\n");
    expect(message).toMatch(/TY0016/);
    expect(message).toMatch(/Async.*await/);
  });
});
