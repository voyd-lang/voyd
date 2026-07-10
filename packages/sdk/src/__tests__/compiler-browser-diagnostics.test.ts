import { describe, expect, it } from "vitest";
import { compile, createSdk } from "@voyd-lang/sdk/browser";

describe("browser compiler diagnostics", () => {
  it("emits runnable balanced wasm through the browser SDK surface", async () => {
    const sdk = createSdk();
    const result = await sdk.compile({
      source: `
pub fn main() -> i32
  42
`,
      optimizationLevel: "balanced",
      boundaryExports: false,
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error(
        result.diagnostics.map((diag) => diag.message).join("\n"),
      );
    }

    await expect(result.run<number>({ entryName: "main" })).resolves.toBe(42);
  });

  it("preserves structured codegen diagnostics without throwing", async () => {
    const source = `
pub fn identity<T>(value: T) -> T
  value

pub fn main()
  0
`;

    const result = await compile(source);
    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("Expected compile failure");
    }

    const diagnostic = result.diagnostics.find(
      (entry) => entry.code === "CG0003",
    );
    expect(diagnostic).toBeDefined();
    if (!diagnostic) {
      throw new Error("Expected CG0003 diagnostic");
    }

    expect(diagnostic.span.file).toBe("/src/index.voyd");
    expect(diagnostic.span.end).toBeGreaterThan(diagnostic.span.start);
  });
});
