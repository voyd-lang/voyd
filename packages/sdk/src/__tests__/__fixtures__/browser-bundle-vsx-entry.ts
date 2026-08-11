import { createSdk } from "@voyd-lang/sdk/browser";
import { createVoydHost } from "@voyd-lang/js-host";
import { createVoydVxAppRuntime } from "@voyd-lang/vx-dom";

type SmokeRunner = () => Promise<number>;

const source = `use std::array::Array
use std::string::type::{ String, new_string }
use std::vx::all

fn App() -> Html<void>
  let features = feature_list()
  <Card>
    <Title>Voyd + VX</Title>
    <p style="margin: 0 0 10px 0; color: #cbd5e1;">Build clean UIs in language, no extensions required</p>
    <List value={features} />
  </Card>

fn Title({ children: Array<Html<void>> }) -> Html<void>
  <h2 style="
    margin: 0 0 8px 0;
    font-size: 20px;
    background: linear-gradient(90deg, #60a5fa, #a78bfa);
    background-clip: text;
    color: transparent;
  ">
    {children}
  </h2>

fn Card({ children: Array<Html<void>> }) -> Html<void>
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

fn List({ value: Array<String> }) -> Html<void>
  <ul style="margin: 0; padding-left: 16px;">
    {value.map((f: String) -> Html<void> => <li style="line-height: 1.6;">{f}</li>)}
  </ul>

fn feature_list() -> Array<String>
  ["WASM speed", "Tiny runtime", "Clean syntax"]


pub fn main() -> Html<void>
  App()
`;

export const runBrowserVsxBundleSmoke: SmokeRunner = async () => {
  const result = await createSdk().compile({ source });
  if (!result.success) {
    throw new Error(JSON.stringify(result.diagnostics, null, 2));
  }
  const wasm = result.wasm;
  const host = await createVoydHost({ wasm, bufferSize: 256 * 1024 });
  const tree = (await createVoydVxAppRuntime({
    host,
    app: false,
    initialModel: {},
    exports: { view: "main" },
    viewReceivesModel: false,
  }).render()) as Record<string, unknown>;
  if (
    !tree ||
    typeof tree !== "object" ||
    tree.kind !== "element" ||
    typeof tree.tag !== "string"
  ) {
    throw new Error(
      `expected main() to return a VX element node, got ${JSON.stringify(tree)}`,
    );
  }
  return wasm.length;
};
