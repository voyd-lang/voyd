import { describe, expect, it } from "vitest";
import { createSdk, type CompileResult } from "@voyd-lang/sdk";

const source = `
@effect(id: "com.example.async")
eff Async
  fn await(tail, value: i32) -> i32

@effect(id: "com.example.log")
eff Log
  fn write(tail, value: i32) -> void

fn call<T>(cb: fn() : (Async, open) -> T) : (open) -> T
  try open
    cb()
  Async::await(tail, value):
    tail(value + 1)

pub fn main() -> i32
  try
    call(() =>
      let value = Async::await(10)
      Log::write(value)
      value
    )
  Log::write(tail, value):
    tail()
`;

const expectCompileSuccess = (
  result: CompileResult
): Extract<CompileResult, { success: true }> => {
  expect(result.success).toBe(true);
  if (!result.success) {
    throw new Error(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
  }
  return result;
};

describe("smoke: open callback effect rows", () => {
  it("handles a required callback effect and forwards the remaining tail", async () => {
    const sdk = createSdk();
    const compiled = expectCompileSuccess(await sdk.compile({ source }));

    await expect(compiled.run<number>({ entryName: "main" })).resolves.toBe(11);
  });
});
