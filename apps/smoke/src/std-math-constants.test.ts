import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createSdk, type CompileResult } from "@voyd/sdk";

const fixtureEntryPath = path.join(
  import.meta.dirname,
  "..",
  "fixtures",
  "std-math-constants.voyd"
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

describe("smoke: std math constants", () => {
  let compiled: Extract<CompileResult, { success: true }>;

  beforeAll(async () => {
    const sdk = createSdk();
    compiled = expectCompileSuccess(await sdk.compile({ entryPath: fixtureEntryPath }));
  });

  it("exposes public module constants", async () => {
    const output = await compiled.run<number>({ entryName: "constants_core" });
    expect(output).toBe(1);
  });

  it("uses constants in conversion helpers", async () => {
    const output = await compiled.run<number>({ entryName: "constants_conversions" });
    expect(output).toBe(1);
  });
});
