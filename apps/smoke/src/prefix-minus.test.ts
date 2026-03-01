import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createSdk, type CompileResult } from "@voyd/sdk";

const fixtureEntryPath = path.join(import.meta.dirname, "..", "fixtures", "prefix-minus.voyd");

const expectCompileSuccess = (
  result: CompileResult
): Extract<CompileResult, { success: true }> => {
  if (!result.success) {
    throw new Error(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
  }
  expect(result.success).toBe(true);
  return result;
};

describe("smoke: prefix minus", () => {
  let compiled: Extract<CompileResult, { success: true }>;

  beforeAll(async () => {
    const sdk = createSdk();
    compiled = expectCompileSuccess(await sdk.compile({ entryPath: fixtureEntryPath }));
  });

  it("supports unary minus intrinsic calls", async () => {
    const output = await compiled.run<number>({ entryName: "prefix_minus_intrinsic" });
    expect(output).toBe(-5);
  });

  it("supports unary minus operator overloads", async () => {
    const output = await compiled.run<number>({ entryName: "prefix_minus_overload" });
    expect(output).toBe(4);
  });
});
