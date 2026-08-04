import { createSdk } from "@voyd-lang/sdk/browser";

type Inbound = { id: number; code: string };
type Outbound =
  | { id: number; ok: true; wasm: Uint8Array }
  | { id: number; ok: false; error: string };

// Signal readiness so the main thread can queue messages safely
self.postMessage({ type: "ready" });

// The worker handles successive editor updates, so retain dependency semantics
// for the worker lifetime instead of allocating a one-shot SDK per message.
const sdk = createSdk({ compilerCache: "memory" });

self.addEventListener("message", async (event: MessageEvent<Inbound>) => {
  const { id, code } = event.data || {};
  try {
    const program = await sdk.compile({ source: code });
    if (!program.success) {
      const message = program.diagnostics
        .map((diagnostic) => diagnostic.message)
        .join("\n");
      throw new Error(message);
    }

    const message: Outbound = { id, ok: true, wasm: program.wasm };
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
