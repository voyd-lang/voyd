import { describe, expect, it } from "vitest";
import { createSdk } from "@voyd/sdk";

describe("node sdk", () => {
  it("compiles and runs a source module", async () => {
    const sdk = createSdk();
    const { wasm } = await sdk.compile({
      source: `pub fn main() -> i32
  42
`,
    });

    const result = await sdk.run<number>({ wasm, entryName: "main" });
    expect(result).toBe(42);
  });
});
