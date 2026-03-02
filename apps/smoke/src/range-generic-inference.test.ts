import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createSdk, type CompileResult } from "@voyd/sdk";

const fixtureEntryPath = path.join(
  import.meta.dirname,
  "..",
  "fixtures",
  "range-generic-inference.voyd"
);

const expectCompileSuccess = (
  result: CompileResult
): Extract<CompileResult, { success: true }> => {
  if (!result.success) {
    throw new Error(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
  }
  expect(result.success).toBe(true);
  return result;
};

describe("smoke: generic range inference", () => {
  let compiled: Extract<CompileResult, { success: true }>;

  beforeAll(async () => {
    const sdk = createSdk();
    compiled = expectCompileSuccess(await sdk.compile({ entryPath: fixtureEntryPath }));
  });

  it("infers Range<f64> for mixed float range bounds", async () => {
    const output = await compiled.run<number>({ entryName: "infer_range_f64_from_bounds" });
    expect(output).toBe(1);
  });

  it("infers Range<i64> for i64-suffixed integer bounds", async () => {
    const output = await compiled.run<number>({
      entryName: "infer_range_i64_from_suffix_literals",
    });
    expect(output).toBe(1);
  });
});
