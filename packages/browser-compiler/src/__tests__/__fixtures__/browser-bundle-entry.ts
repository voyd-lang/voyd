import { compile } from "../../browser.js";

type SmokeRunner = () => Promise<number>;

const source = `use util::math::all
use util::ops::all

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
  const module = await compile(source, { files });
  return toBytes(module.emitBinary()).length;
};

(globalThis as { __voydBrowserSmoke__?: SmokeRunner }).__voydBrowserSmoke__ =
  run;
