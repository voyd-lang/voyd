import { describe, expect, it } from "vitest";
import { createSdk, type CompileResult } from "@voyd-lang/sdk";

const expectCompileSuccess = (
  result: CompileResult,
): Extract<CompileResult, { success: true }> => {
  if (!result.success) {
    throw new Error(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
  }
  expect(result.success).toBe(true);
  return result;
};

describe("smoke: string slice apis", () => {
  it("supports slice-first parsing helpers from outside std", async () => {
    const sdk = createSdk();
    const compiled = expectCompileSuccess(
      await sdk.compile({
        source: `use std::string::type::{ ParseIntError, StringIndex, StringSlice }

pub fn main() -> i32
  let request = " count=41 ".as_slice().trimmed()
  if not request.starts_with("count"):
    return 0

  match(request.split_once(on: 61))
    Some<(StringSlice, StringSlice)> { value: pair }:
      match(pair.1.parse_int())
        Ok<i32> { value }:
          match(request.reverse_find("1"))
            Some<StringIndex>:
              value + 1
            None:
              0
        Err<ParseIntError>:
          0
    None:
      0
`,
      }),
    );

    await expect(compiled.run<number>({ entryName: "main" })).resolves.toBe(42);
  });
});
