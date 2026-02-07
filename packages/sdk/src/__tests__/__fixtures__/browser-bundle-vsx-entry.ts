import { compile } from "@voyd/sdk/browser";
import { createVoydHost } from "@voyd/js-host";

type SmokeRunner = () => Promise<number>;

const source = `use std::all
use std::msgpack::MsgPack
use std::vx::all

fn App()
  let features = ["WASM speed", "Tiny runtime", "Clean syntax"]
  <Card>
    <Title>Voyd + VSX</Title>
    <p style="margin: 0 0 10px 0; color: #cbd5e1;">Build clean UIs in language, no extensions required</p>
    <List value={features} />
  </Card>

fn Title({ children: Array<MsgPack> })
  <h2 style="
    margin: 0 0 8px 0;
    font-size: 20px;
    background: linear-gradient(90deg, #60a5fa, #a78bfa);
    background-clip: text;
    color: transparent;
  ">
    {children}
  </h2>

fn Card({ children: Array<MsgPack> })
  <div style="
    font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    margin: 8px;
    padding: 16px;
    border-radius: 12px;
    background: #0b1020;
    color: #e5e7eb;
    border: 1px solid rgba(255,255,255,0.08);
  ">
    {children}
  </div>

fn List({ value: Array<String> })
  <ul style="margin: 0; padding-left: 16px;">
    {value.map(f => <li style="line-height: 1.6;">{f}</li>)}
  </ul>


pub fn main()
  App()
`;

const toBytes = (
  result: Uint8Array | { binary?: Uint8Array; output?: Uint8Array }
): Uint8Array =>
  result instanceof Uint8Array
    ? result
    : result.output ?? result.binary ?? new Uint8Array();

const run: SmokeRunner = async () => {
  const result = await compile(source);
  if (!result.success) {
    throw new Error(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
  }
  const wasm = toBytes(result.module.emitBinary());
  const host = await createVoydHost({ wasm, bufferSize: 256 * 1024 });
  const tree = await host.run<any>("main");
  if (!tree || typeof tree !== "object" || typeof tree.name !== "string") {
    throw new Error("expected main() to return a msgpack node");
  }
  return wasm.length;
};

(globalThis as { __voydBrowserSmoke__?: SmokeRunner }).__voydBrowserSmoke__ =
  run;
