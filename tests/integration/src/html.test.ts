import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSdk, type CompileResult } from "@voyd-lang/sdk";
import { createVoydHost } from "@voyd-lang/sdk/js-host";
import {
  createVoydVxAppRuntime,
  type VoydVxAppHost,
} from "@voyd-lang/vx-dom";

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

const readVxExport = (
  host: VoydVxAppHost,
  entryName: string,
): Promise<unknown> =>
  Promise.resolve(
    createVoydVxAppRuntime({
      host,
      app: false,
      initialModel: {},
      exports: { view: entryName },
      viewReceivesModel: false,
    }).render(),
  );

describe("integration: html.voyd", () => {
  it("returns the expected opaque HTML plan", async () => {
    const sdk = createSdk();
    const entryPath = path.join(fixtureRoot, "html.voyd");
    const result = expectCompileSuccess(await sdk.compile({ entryPath }));
    const host = await createVoydHost({ wasm: result.wasm });
    const output = await readVxExport(host, "main");

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
      readVxExport(host, "empty_children_with_shadows"),
    ).resolves.toEqual({
      kind: "element",
      tag: "input",
      children: [],
    });

    await expect(
      readVxExport(host, "option_attributes"),
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
