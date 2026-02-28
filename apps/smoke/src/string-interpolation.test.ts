import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createSdk, type CompileResult } from "@voyd/sdk";

const fixtureEntryPath = path.join(
  import.meta.dirname,
  "..",
  "fixtures",
  "string-interpolation.voyd"
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

describe("smoke: string interpolation", () => {
  let compiled: Extract<CompileResult, { success: true }>;

  beforeAll(async () => {
    const sdk = createSdk();
    compiled = expectCompileSuccess(await sdk.compile({ entryPath: fixtureEntryPath }));
  });

  it("evaluates interpolation placeholders", async () => {
    const output = await compiled.run<number>({ entryName: "interpolation_basic" });
    expect(output).toBe(1);
  });

  it("treats escaped interpolation markers as text", async () => {
    const output = await compiled.run<number>({ entryName: "interpolation_escape" });
    expect(output).toBe(1);
  });

  it("supports multiple interpolation placeholders in one string", async () => {
    const output = await compiled.run<number>({ entryName: "interpolation_chain" });
    expect(output).toBe(1);
  });
});
