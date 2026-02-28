import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createSdk, type CompileResult } from "@voyd/sdk";

const fixtureEntryPath = path.join(import.meta.dirname, "..", "fixtures", "range-for.voyd");

const expectCompileSuccess = (
  result: CompileResult
): Extract<CompileResult, { success: true }> => {
  if (!result.success) {
    throw new Error(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
  }
  expect(result.success).toBe(true);
  return result;
};

describe("smoke: range for loops", () => {
  let compiled: Extract<CompileResult, { success: true }>;

  beforeAll(async () => {
    const sdk = createSdk();
    compiled = expectCompileSuccess(await sdk.compile({ entryPath: fixtureEntryPath }));
  });

  it("iterates half-open ranges", async () => {
    const output = await compiled.run<number>({ entryName: "range_for_half_open" });
    expect(output).toBe(10);
  });

  it("iterates inclusive ranges", async () => {
    const output = await compiled.run<number>({ entryName: "range_for_inclusive" });
    expect(output).toBe(15);
  });

  it("supports nested range iteration", async () => {
    const output = await compiled.run<number>({ entryName: "range_for_nested" });
    expect(output).toBe(18);
  });
});
