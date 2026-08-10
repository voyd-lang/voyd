import path from "node:path";
import { decode } from "@msgpack/msgpack";
import { describe, expect, it } from "vitest";
import { createSdk, type CompileResult } from "@voyd-lang/sdk";

const fixtureRoot = path.resolve(import.meta.dirname, "../fixtures");

const expectCompileSuccess = (
  result: CompileResult,
): Extract<CompileResult, { success: true }> => {
  expect(result.success).toBe(true);
  if (!result.success) {
    throw new Error(
      result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"),
    );
  }
  return result;
};

describe("integration: html.voyd", () => {
  it("returns the expected opaque HTML plan", async () => {
    const sdk = createSdk();
    const entryPath = path.join(fixtureRoot, "html.voyd");
    const result = expectCompileSuccess(await sdk.compile({ entryPath }));

    const encoded = await result.run<Uint8Array>({
      entryName: "main",
    });
    const output = decode(encoded);

    expect(output).toEqual({
      attrs: {
        class: "greeting",
        visible: true,
      },
      kind: "element",
      tag: "div",
      children: [
        { kind: "text", value: "Hi there " },
        {
          attrs: {
            class: "big",
          },
          kind: "element",
          tag: "span",
          children: [{ kind: "text", value: "hi" }],
        },
        {
          kind: "element",
          tag: "i",
          children: [{ kind: "text", value: "This is italic" }],
        },
      ],
    });

    await expect(
      result
        .run<Uint8Array>({ entryName: "empty_children_with_shadows" })
        .then((value) => decode(value)),
    ).resolves.toEqual({
      kind: "element",
      tag: "input",
      children: [],
    });

    await expect(
      result
        .run<Uint8Array>({ entryName: "option_attributes" })
        .then((value) => decode(value)),
    ).resolves.toEqual({
      attrs: {
        selected: true,
        value: "voyd",
      },
      kind: "element",
      tag: "option",
      children: [{ kind: "text", value: "Voyd" }],
    });
  });
});
