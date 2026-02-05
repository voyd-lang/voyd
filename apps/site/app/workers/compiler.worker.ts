import { compile } from "@voyd/sdk/browser";
import { createVoydHost } from "@voyd/js-host";

type Inbound = { id: number; code: string };
type Outbound =
  | { id: number; ok: true; tree: any }
  | { id: number; ok: false; error: string };

const toBytes = (
  result: Uint8Array | { binary?: Uint8Array; output?: Uint8Array },
): Uint8Array =>
  result instanceof Uint8Array
    ? result
    : (result.output ?? result.binary ?? new Uint8Array());

// Signal readiness so the main thread can queue messages safely
self.postMessage({ type: "ready" });

self.addEventListener("message", async (event: MessageEvent<Inbound>) => {
  const { id, code } = event.data || {};
  try {
    const mod = await compile(code);
    const wasm = toBytes(mod.emitBinary());
    const host = await createVoydHost({ wasm, bufferSize: 256 * 1024 });
    const tree = await host.run("main");
    const message: Outbound = { id, ok: true, tree };
    (self as unknown as Worker).postMessage(message);
  } catch (err) {
    const message: Outbound = {
      id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
    (self as unknown as Worker).postMessage(message);
  }
});
