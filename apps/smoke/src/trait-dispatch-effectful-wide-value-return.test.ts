import path from "node:path";
import type { CompileResult } from "@voyd-lang/sdk";
import { createSdk } from "@voyd-lang/sdk/node";
import { beforeAll, describe, expect, it } from "vitest";

const fixtureEntryPath = path.join(
  import.meta.dirname,
  "..",
  "fixtures",
  "trait-dispatch-effectful-wide-value-return.voyd",
);

const expectCompileSuccess = (
  result: CompileResult,
): Extract<CompileResult, { success: true }> => {
  if (result.success) {
    return result;
  }
  throw new Error(result.diagnostics.map((diag) => diag.message).join("\n"));
};

describe("smoke: effectful trait dispatch wide value return", () => {
  let compiled: Extract<CompileResult, { success: true }>;

  beforeAll(async () => {
    const sdk = createSdk();
    compiled = expectCompileSuccess(
      await sdk.compile({ entryPath: fixtureEntryPath, optimize: true }),
    );
  });

  it("preserves wide value results from pure impl wrappers", async () => {
    const output = await compiled.run<number>({ entryName: "main" });
    expect(output).toBe(11);
  });
});
