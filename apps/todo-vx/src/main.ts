import { createVoydHost } from "@voyd-lang/sdk/js-host";
import { createVoydVxAppRuntime, mountVxApp } from "@voyd-lang/vx-dom/browser";
import wasmUrl from "./generated/main.wasm?url";
import "./style.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("Missing #root element");
}

const start = async () => {
  const wasm = new Uint8Array(await (await fetch(wasmUrl)).arrayBuffer());
  const host = await createVoydHost({
    wasm,
    bufferSize: 256 * 1024,
  });
  const app = createVoydVxAppRuntime({ host });
  const mounted = await mountVxApp({ container: root, app });

  import.meta.hot?.dispose(() => mounted.dispose());
};

start().catch((reason) => {
  console.error(reason);
  root.textContent = reason instanceof Error ? reason.message : String(reason);
});
