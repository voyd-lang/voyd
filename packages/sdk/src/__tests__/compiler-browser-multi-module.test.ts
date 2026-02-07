import { describe, expect, it } from "vitest";
import { compile } from "@voyd/sdk/browser";

const toBytes = (
  result: Uint8Array | { binary?: Uint8Array; output?: Uint8Array }
): Uint8Array =>
  result instanceof Uint8Array
    ? result
    : result.output ?? result.binary ?? new Uint8Array();

describe("browser compiler modules", () => {
  it("compiles a multi-module fixture", async () => {
    const source = `use util::math::all
use util::ops::all

pub fn main() -> i32
  add(20, sub(30, 10))
`;

    const result = await compile(source, {
      files: {
        "util/math.voyd": `pub fn add(a: i32, b: i32) -> i32
  a + b
`,
        "util/ops.voyd": `pub fn sub(a: i32, b: i32) -> i32
  a - b
`,
      },
    });
    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
    }

    const bytes = toBytes(result.module.emitBinary());
    expect(bytes.length).toBeGreaterThan(0);
  });
});
