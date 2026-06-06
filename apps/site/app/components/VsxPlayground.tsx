import { useEffect, useRef, useState } from "react";
import VoydEditor from "./VoydEditor";

type DisposableRenderer = {
  dispose(): void;
};

export const VsxPlayground = ({ value }: { value: string }) => {
  const renderRef = useRef<HTMLDivElement>(null);
  const workerRef = useRef<Worker | null>(null);
  const rendererRef = useRef<DisposableRenderer | null>(null);
  const workerReadyRef = useRef(false);
  const readyWaitersRef = useRef<Array<(w: Worker) => void>>([]);
  const [isCompiling, setIsCompiling] = useState(false);
  const [stage, setStage] = useState<"idle" | "loadingCompiler" | "compiling">(
    "idle"
  );
  const reqIdRef = useRef(0);
  const pendingRef = useRef(new Map<number, (payload: any) => void>());

  useEffect(() => {
    return () => {
      if (workerRef.current) {
        workerRef.current.terminate();
        workerRef.current = null;
      }
      rendererRef.current?.dispose();
      rendererRef.current = null;
      pendingRef.current.clear();
    };
  }, []);

  const getOrCreateWorker = () => {
    if (workerRef.current) return workerRef.current;
    const worker = new Worker(
      new URL("../workers/compiler.worker.ts", import.meta.url),
      { type: "module" }
    );
    workerRef.current = worker;
    worker.onmessage = (ev: MessageEvent<any>) => {
      const data = ev.data || {};
      // Worker ready handshake
      if (data && data.type === "ready") {
        workerReadyRef.current = true;
        const waiters = readyWaitersRef.current;
        readyWaitersRef.current = [];
        for (const fn of waiters) fn(worker);
        return;
      }
      const { id, ok, wasm, error } = data;
      const resolve = pendingRef.current.get(id);
      if (!resolve) return;
      pendingRef.current.delete(id);
      resolve({ ok, wasm, error });
    };
    worker.onerror = (ev: ErrorEvent) => {
      const err = new Error(ev.message || "Worker error");
      // Reject all pending requests on fatal worker error
      for (const [id, resolver] of pendingRef.current.entries()) {
        resolver({ ok: false, error: err.message });
        pendingRef.current.delete(id);
      }
      try {
        worker.terminate();
      } catch {}
      workerRef.current = null;
      workerReadyRef.current = false;
    };
    worker.onmessageerror = () => {
      const err = new Error("Worker message parse error");
      for (const [id, resolver] of pendingRef.current.entries()) {
        resolver({ ok: false, error: err.message });
        pendingRef.current.delete(id);
      }
      try {
        worker.terminate();
      } catch {}
      workerRef.current = null;
      workerReadyRef.current = false;
    };
    return worker;
  };

  const compileInWorker = (code: string) => {
    return new Promise<Uint8Array>((resolve, reject) => {
      const worker = getOrCreateWorker();
      const send = () => {
        setStage("compiling");
        const id = ++reqIdRef.current;
        let timeout: any = null;
        const clear = () => {
          if (timeout) clearTimeout(timeout);
        };
        pendingRef.current.set(id, (payload: any) => {
          clear();
          if (payload.ok) resolve(payload.wasm);
          else reject(new Error(payload.error || "Compile failed"));
        });
        worker.postMessage({ id, code });
        timeout = setTimeout(() => {
          if (pendingRef.current.has(id)) {
            pendingRef.current.delete(id);
            reject(new Error("Compile timed out. Try again."));
          }
        }, 30000);
      };
      if (workerReadyRef.current) send();
      else readyWaitersRef.current.push(() => send());
    });
  };

  const onPlay = async (code: string) => {
    try {
      setIsCompiling(true);
      setStage(workerReadyRef.current ? "compiling" : "loadingCompiler");
      if (!renderRef.current) return;
      const wasm = await compileInWorker(code);
      const [{ createVoydHost }, { createVoydVxAppRuntime, mountVxApp }] =
        await Promise.all([
          import("@voyd-lang/sdk/js-host"),
          import("@voyd-lang/vx-dom/browser"),
        ]);
      const host = await createVoydHost({
        wasm,
        bufferSize: 256 * 1024,
      });
      const app = createVoydVxAppRuntime({
        host,
      });

      rendererRef.current?.dispose();
      renderRef.current.textContent = "";
      rendererRef.current = await mountVxApp({
        container: renderRef.current,
        app,
      });
    } catch (err) {
      // TODO: Optional: surface compile errors in the UI
      console.error("Compile error:", err);
    } finally {
      setIsCompiling(false);
      setStage("idle");
    }
  };

  return (
    <div className="size-full flex flex-col md:flex-row gap-6">
      <div className="h-[260px] md:h-full w-full md:w-1/2 min-w-0">
        <VoydEditor
          value={value}
          isLoading={isCompiling}
          onPlay={(c) => {
            if (c) onPlay(c);
          }}
        />
      </div>
      <div className="relative h-[260px] md:h-full border border-gray-500 rounded w-full md:w-1/2 min-w-0 overflow-auto">
        {stage === "loadingCompiler" ? (
          <div className="absolute top-2 right-2 text-[11px] px-2 py-1 rounded bg-yellow-900/60 text-yellow-100 border border-yellow-700 shadow-sm">
            Loading compiler…
          </div>
        ) : null}
        <div ref={renderRef}>
          <p className="p-8">Hit the play button in the editor to render</p>
        </div>
      </div>
    </div>
  );
};
