import { createVoydHost } from "@voyd-lang/sdk/js-host";
import { createVoydVxAppRuntime, hydrateVxApp } from "@voyd-lang/vx-dom/browser";
import wasmUrl from "./generated/client.wasm?url";
import "./style.css";

const hydration = document.querySelector<HTMLScriptElement>("[data-voyd-hydration]");
const targetSelector = hydration?.dataset.voydHydration;
const target = targetSelector ? document.querySelector(targetSelector) : undefined;

if (!hydration || !target) {
  throw new Error("Mini Voydpedia hydration target was not found.");
}

const initialModel = JSON.parse(hydration.textContent ?? "null") as unknown;

const start = async () => {
  const wasm = new Uint8Array(await (await fetch(wasmUrl)).arrayBuffer());
  const host = await createVoydHost({
    wasm,
    bufferSize: 1024 * 1024,
    defaultAdapters: { runtime: "browser" },
  });
  const app = createVoydVxAppRuntime({ host, initialModel });
  const mounted = await hydrateVxApp({ container: target, app });

  import.meta.hot?.dispose(() => mounted.dispose());
};

start().catch((reason) => {
  console.error(reason);
  target.textContent = reason instanceof Error ? reason.message : String(reason);
});
