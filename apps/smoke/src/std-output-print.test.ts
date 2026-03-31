import { describe, expect, it } from "vitest";
import { createSdk, type CompileResult } from "@voyd-lang/sdk";
import { createVoydHost } from "@voyd-lang/sdk/js-host";

const expectCompileSuccess = (
  result: CompileResult
): Extract<CompileResult, { success: true }> => {
  if (!result.success) {
    throw new Error(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
  }
  expect(result.success).toBe(true);
  return result;
};

describe("smoke: std output write_line", () => {
  it("supports bare write_line from an explicit std import", async () => {
    const sdk = createSdk();
    const compiled = expectCompileSuccess(
      await sdk.compile({
        source: `use std::output::{ Output, write_line }

pub fn write_text(): Output -> i32
  let _ = write_line("hello")
  1

pub fn write_text_again(): Output -> i32
  let _ = write_line("42")
  1
`,
      })
    );

    const writes: Array<{ target: string; value: string }> = [];
    const host = await createVoydHost({
      wasm: compiled.wasm,
      defaultAdapters: {
        runtime: "node",
        runtimeHooks: {
          write: async ({ target, value }) => {
            writes.push({ target, value });
          },
        },
      },
    });

    await expect(host.run<number>("write_text")).resolves.toBe(1);
    await expect(host.run<number>("write_text_again")).resolves.toBe(1);

    expect(writes).toEqual([
      { target: "stdout", value: "hello\n" },
      { target: "stdout", value: "42\n" },
    ]);
  });
});
