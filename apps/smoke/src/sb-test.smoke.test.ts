import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSdk } from "@voyd/sdk";

const assertNoCompileErrors = (
  diagnostics: { severity: string; message: string }[],
): void => {
  const errors = diagnostics.filter((d) => d.severity === "error");
  if (errors.length === 0) return;
  throw new Error(errors.map((d) => d.message).join("\n"));
};

describe("smoke: sb/test.voyd", () => {
  it("returns the expected MsgPack object", async () => {
    const sdk = createSdk();
    const entryPath = path.join(process.cwd(), "fixtures", "test.voyd");
    const result = await sdk.compile({ entryPath });
    assertNoCompileErrors(result.diagnostics);

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
