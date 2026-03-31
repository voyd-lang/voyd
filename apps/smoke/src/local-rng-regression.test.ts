import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createSdk, type CompileResult } from "@voyd-lang/sdk";

const fixtureEntryPath = path.join(
  import.meta.dirname,
  "..",
  "fixtures",
  "local-rng-regression.voyd"
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

describe("smoke: local rng regression", () => {
  let compiled: Extract<CompileResult, { success: true }>;

  beforeAll(async () => {
    const sdk = createSdk();
    compiled = expectCompileSuccess(await sdk.compile({ entryPath: fixtureEntryPath }));
  });

  it("keeps the positive-seed LocalRng stream in a sane range", async () => {
    const result = await compiled.run<number>({ entryName: "seeded_42_sum_200" });
    expect(result).toBeGreaterThan(90);
    expect(result).toBeLessThan(110);
  });

  it("keeps the negative-seed LocalRng stream in a sane range", async () => {
    const result = await compiled.run<number>({ entryName: "seeded_negative_sum_200" });
    expect(result).toBeGreaterThan(90);
    expect(result).toBeLessThan(120);
  });
});
