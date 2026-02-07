import { compile } from "@voyd/sdk/browser";

type SmokeRunner = () => Promise<number>;

const source = `use src::util::math::all
use src::util::ops::all

pub fn main() -> i32
  add(20, sub(30, 10))
`;

const files: Record<string, string> = {
  "util/math.voyd": `pub fn add(a: i32, b: i32) -> i32
  a + b
`,
  "util/ops.voyd": `pub fn sub(a: i32, b: i32) -> i32
  a - b
`,
};

const toBytes = (
  result: Uint8Array | { binary?: Uint8Array; output?: Uint8Array }
): Uint8Array =>
  result instanceof Uint8Array
    ? result
    : result.output ?? result.binary ?? new Uint8Array();

const run: SmokeRunner = async () => {
  const result = await compile(source, { files });
  if (!result.success) {
    throw new Error(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
  }
  return toBytes(result.module.emitBinary()).length;
};

(globalThis as { __voydBrowserSmoke__?: SmokeRunner }).__voydBrowserSmoke__ =
  run;
