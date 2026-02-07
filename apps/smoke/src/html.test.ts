import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSdk, type CompileResult } from "@voyd/sdk";

const expectCompileSuccess = (
  result: CompileResult,
): Extract<CompileResult, { success: true }> => {
  expect(result.success).toBe(true);
  if (!result.success) {
    throw new Error(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
  }
  return result;
};

describe("smoke: html.voyd", () => {
  it("returns the expected MsgPack object", async () => {
    const sdk = createSdk();
    const entryPath = path.join(process.cwd(), "fixtures", "html.voyd");
    const result = expectCompileSuccess(await sdk.compile({ entryPath }));

    const output = await result.run<Record<string, unknown>>({
      entryName: "main",
    });

    expect(output).toEqual({
      attributes: [
        ["class", "greeting"],
        ["visible", "true"],
      ],
      name: "div",
      children: [
        "Hi there ",
        {
          attributes: [["class", "big"]],
          name: "span",
          children: ["hi"],
        },
        {
          name: "i",
          children: ["This is italic"],
        },
      ],
    });
  });
});
