import { describe, expect, it } from "vitest";
import { createSdk, type OptimizationLevel } from "@voyd-lang/sdk";

const SOURCE = `
fn add_one(value: i32) -> i32
  value + 1

pub fn main() -> i32
  add_one(41)
`;

describe("SDK optimization levels", () => {
  it("returns a diagnostic for an invalid JavaScript level value", async () => {
    const result = await createSdk().compile({
      source: SOURCE,
      optimizationLevel: "balance" as OptimizationLevel,
    });

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("expected compilation to fail");
    }
    expect(
      result.diagnostics.map(({ message }) => message).join("\n"),
    ).toContain('unknown optimization level "balance"');
  });
});
