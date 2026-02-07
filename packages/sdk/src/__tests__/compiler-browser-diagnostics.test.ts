import { describe, expect, it } from "vitest";
import { compile } from "@voyd/sdk/browser";

describe("browser compiler diagnostics", () => {
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

    const diagnostic = result.diagnostics.find((entry) => entry.code === "CG0003");
    expect(diagnostic).toBeDefined();
    if (!diagnostic) {
      throw new Error("Expected CG0003 diagnostic");
    }

    expect(diagnostic.span.file).toBe("/src/index.voyd");
    expect(diagnostic.span.end).toBeGreaterThan(diagnostic.span.start);
  });
});
