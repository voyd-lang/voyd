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
});
