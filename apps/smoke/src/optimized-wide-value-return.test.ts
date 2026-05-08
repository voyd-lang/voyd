import path from "node:path";
import type { CompileResult } from "@voyd-lang/sdk";
import { createSdk } from "@voyd-lang/sdk/node";
import { beforeAll, describe, expect, it } from "vitest";

const fixtureEntryPath = path.join(
  import.meta.dirname,
  "..",
  "fixtures",
  "optimized-wide-value-return.voyd",
);

const expectCompileSuccess = (
  result: CompileResult,
): Extract<CompileResult, { success: true }> => {
  if (result.success) {
    return result;
  }
  throw new Error(result.diagnostics.map((diag) => diag.message).join("\n"));
};

describe("smoke: optimized wide value returns", () => {
  let compiled: Extract<CompileResult, { success: true }>;

  beforeAll(async () => {
    const sdk = createSdk();
    compiled = expectCompileSuccess(
      await sdk.compile({ entryPath: fixtureEntryPath, optimize: true }),
    );
  });

  it("preserves direct effectful wide value results", async () => {
    const output = await compiled.run<number>({
      entryName: "direct_effectful_wide_value_return",
    });
    expect(output).toBe(11);
  });

  it("preserves trait-dispatched wide value results", async () => {
    const output = await compiled.run<number>({
      entryName: "trait_dispatch_wide_value_return",
    });
    expect(output).toBe(11);
  });

  it("preserves effectful trait-dispatched wide value results", async () => {
    const output = await compiled.run<number>({
      entryName: "trait_dispatch_effectful_wide_value_return",
    });
    expect(output).toBe(11);
  });
});
