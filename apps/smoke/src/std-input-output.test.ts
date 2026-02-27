import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createSdk, type CompileResult } from "@voyd/sdk";
import { createVoydHost } from "@voyd/sdk/js-host";

const fixtureEntryPath = path.join(
  import.meta.dirname,
  "..",
  "fixtures",
  "std-input-output.voyd"
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

describe("smoke: std input/output", () => {
  let compiled: Extract<CompileResult, { success: true }>;

  beforeAll(async () => {
    const sdk = createSdk();
    compiled = expectCompileSuccess(await sdk.compile({ entryPath: fixtureEntryPath }));
  });

  it("runs std input/output success path with default host adapters", async () => {
    const writes: Array<{ target: string; value: string }> = [];
    const byteWrites: Array<{ target: string; bytes: number[] }> = [];
    const flushes: string[] = [];
    const host = await createVoydHost({
      wasm: compiled.wasm,
      defaultAdapters: {
        runtime: "node",
        runtimeHooks: {
          readBytes: async () => Uint8Array.from([7, 8, 9]),
          isInputTty: () => true,
          write: async ({ target, value }) => {
            writes.push({ target, value });
          },
          writeBytes: async ({ target, bytes }) => {
            byteWrites.push({ target, bytes: Array.from(bytes.values()) });
          },
          flush: async ({ target }) => {
            flushes.push(target);
          },
          isOutputTty: (target) => target === "stdout",
        },
      },
    });

    const output = await host.run<number>("io_success");
    expect(output).toBe(24);
    expect(writes).toEqual([
      { target: "stdout", value: "hello" },
      { target: "stdout", value: "ok\n" },
    ]);
    expect(byteWrites).toEqual([{ target: "stderr", bytes: [7, 8] }]);
    expect(flushes).toEqual(["stdout", "stderr"]);
  });

  it("runs std input/output probe entrypoints", async () => {
    const host = await createVoydHost({
      wasm: compiled.wasm,
      defaultAdapters: {
        runtime: "node",
        runtimeHooks: {
          readBytes: async () => Uint8Array.from([7, 8, 9]),
          isInputTty: () => true,
          write: async () => {},
          writeBytes: async () => {},
          flush: async () => {},
          isOutputTty: (target) => target === "stdout",
        },
      },
    });

    await expect(host.run<number>("io_tty_probe")).resolves.toBe(1);
    await expect(host.run<number>("io_write_probe")).resolves.toBe(1);
    await expect(host.run<number>("io_write_line_probe")).resolves.toBe(1);
    await expect(host.run<number>("io_write_bytes_probe")).resolves.toBe(1);
    await expect(host.run<number>("io_write_combo_probe")).resolves.toBe(1);
    await expect(host.run<number>("io_read_bytes_probe")).resolves.toBe(24);
    await expect(host.run<number>("io_read_bytes_to_write_probe")).resolves.toBe(1);
    await expect(host.run<number>("io_input_combo_probe")).resolves.toBe(24);
    await expect(host.run<number>("io_output_combo_probe")).resolves.toBe(1);
  });

  it("covers read eof/error and output error paths", async () => {
    const eofHost = await createVoydHost({
      wasm: compiled.wasm,
      defaultAdapters: {
        runtime: "node",
        runtimeHooks: {
          readBytes: async () => null,
        },
      },
    });
    await expect(eofHost.run<number>("io_read_eof")).resolves.toBe(1);

    const readErrorHost = await createVoydHost({
      wasm: compiled.wasm,
      defaultAdapters: {
        runtime: "node",
        runtimeHooks: {
          readBytes: async () => {
            throw new Error("read failed");
          },
        },
      },
    });
    await expect(readErrorHost.run<number>("io_read_error")).resolves.toBe(1);

    const outputErrorHost = await createVoydHost({
      wasm: compiled.wasm,
      defaultAdapters: {
        runtime: "node",
        runtimeHooks: {
          write: async () => {
            throw new Error("write failed");
          },
        },
      },
    });
    await expect(outputErrorHost.run<number>("io_output_error")).resolves.toBe(1);
  });
});
