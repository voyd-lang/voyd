import { createSdk } from "@voyd/sdk/browser";

type Inbound = { id: number; code: string };
type Outbound =
  | { id: number; ok: true; tree: any }
  | { id: number; ok: false; error: string };

// Signal readiness so the main thread can queue messages safely
self.postMessage({ type: "ready" });

self.addEventListener("message", async (event: MessageEvent<Inbound>) => {
  const { id, code } = event.data || {};
  try {
    const { compile } = createSdk();
    const program = await compile({ source: code });
    if (!program.success) {
      const message = program.diagnostics
        .map((diagnostic) => diagnostic.message)
        .join("\n");
      throw new Error(message);
    }

    const tree = await program.run({ entryName: "main" });
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
