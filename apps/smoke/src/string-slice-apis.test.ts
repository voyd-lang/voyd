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
  it("supports owned String read helpers that forward to slices from outside std", async () => {
    const sdk = createSdk();
    const compiled = expectCompileSuccess(
      await sdk.compile({
        source: `use std::string::type::{ ParseIntError, StringIndex, StringSlice }

pub fn main() -> i32
  let request = " count=41 ".trimmed()
  if not "count".starts_with("co"):
    return 0
  if not request.starts_with("count"):
    return 0
  if not "abc".slice(bytes: 1, len: 1).starts_with("b"):
    return 0
  if not "a😀c".slice(runes: 1, len: 1).starts_with("😀"):
    return 0

  match(" count=41 ".get_byte(0))
    Some<i32> { value }:
      if value != 32:
        return 0
    None:
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
