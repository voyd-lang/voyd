import { beforeAll, describe, expect, it } from "vitest";
import { createSdk, type CompileResult } from "@voyd/sdk";

const LARGE_READ_BYTES = 33_000;
const source = `use std::bytes::Bytes
use std::error::IoError
use std::input::read_bytes
use std::optional::types::all
use std::result::types::all

pub fn main() -> i32
  match(read_bytes(${LARGE_READ_BYTES}))
    Ok<Option<Bytes>> { value }:
      match(value)
        Some<Bytes> { value: bytes }:
          bytes.len()
        None:
          -2
    Err<IoError>:
      -1
`;

const expectCompileSuccess = (
  result: CompileResult
): Extract<CompileResult, { success: true }> => {
  if (!result.success) {
    throw new Error(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
  }
  expect(result.success).toBe(true);
  return result;
};

describe("smoke: effect buffer size", () => {
  const sdk = createSdk();
  let compiled: Extract<CompileResult, { success: true }>;
  const largeInput = new Uint8Array(LARGE_READ_BYTES).fill(255);

  beforeAll(async () => {
    compiled = expectCompileSuccess(await sdk.compile({ source }));
  });

  it("uses a 128 KiB default effect buffer for sdk runs", async () => {
    await expect(
      compiled.run<number>({
        entryName: "main",
        defaultAdapters: {
          runtime: "node",
          runtimeHooks: {
            readBytes: async () => largeInput,
          },
        },
      })
    ).resolves.toBe(LARGE_READ_BYTES);
  });

  it("plumbs defaultAdapters through sdk.run", async () => {
    await expect(
      sdk.run<number>({
        wasm: compiled.wasm,
        entryName: "main",
        defaultAdapters: {
          runtime: "node",
          runtimeHooks: {
            readBytes: async () => largeInput,
          },
        },
      })
    ).resolves.toBe(LARGE_READ_BYTES);
  });

  it("respects explicit sdk effectBufferSize overrides", async () => {
    await expect(
      compiled.run<number>({
        entryName: "main",
        bufferSize: 256 * 1024,
        defaultAdapters: {
          runtime: "node",
          effectBufferSize: 64 * 1024,
          runtimeHooks: {
            readBytes: async () => largeInput,
          },
        },
      })
    ).resolves.toBe(-1);
  });
});
