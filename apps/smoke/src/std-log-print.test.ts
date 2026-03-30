import { describe, expect, it, vi } from "vitest";
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

describe("smoke: std log print", () => {
  it("supports bare print from the implicit prelude", async () => {
    const sdk = createSdk();
    const compiled = expectCompileSuccess(
      await sdk.compile({
        source: `pub fn print_text(): log::Log -> void
  print("hello")

pub fn print_number(): log::Log -> void
  print(42)
`,
      })
    );

    const info = vi.fn();
    const host = await createVoydHost({
      wasm: compiled.wasm,
      defaultAdapters: {
        runtime: "node",
        logWriter: {
          trace: vi.fn(),
          debug: vi.fn(),
          info,
          warn: vi.fn(),
          error: vi.fn(),
        },
      },
    });

    await host.run<void>("print_text");
    await host.run<void>("print_number");

    expect(info).toHaveBeenNthCalledWith(1, "hello", {});
    expect(info).toHaveBeenNthCalledWith(2, "42", {});
  });
});
