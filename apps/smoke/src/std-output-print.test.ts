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

describe("smoke: std output print", () => {
  it("supports bare print from the implicit prelude", async () => {
    const sdk = createSdk();
    const compiled = expectCompileSuccess(
      await sdk.compile({
        source: `use std::output::Output

pub fn print_text(): Output -> i32
  print("hello")
  1

pub fn print_number(): Output -> i32
  print(42)
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

    await expect(host.run<number>("print_text")).resolves.toBe(1);
    await expect(host.run<number>("print_number")).resolves.toBe(1);

    expect(writes).toEqual([
      { target: "stdout", value: "hello\n" },
      { target: "stdout", value: "42\n" },
    ]);
  });
});
