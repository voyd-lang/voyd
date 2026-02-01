import { compile, getWasmFn, getWasmInstance } from "@voyd/sdk/browser";
import { callComponentFn } from "@voyd/lib/vsx-dom/client";

type Inbound = { id: number; code: string };
type Outbound =
  | { id: number; ok: true; tree: any }
  | { id: number; ok: false; error: string };

// Signal readiness so the main thread can queue messages safely
self.postMessage({ type: "ready" });

self.addEventListener("message", async (event: MessageEvent<Inbound>) => {
  const { id, code } = event.data || {};
  try {
    const mod = await compile(code);
    const instance = getWasmInstance(mod);
    const main = getWasmFn("main", instance) as unknown as any;
    const tree = callComponentFn(main, { instance });
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
