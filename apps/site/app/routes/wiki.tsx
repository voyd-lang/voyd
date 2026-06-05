import { useEffect, useRef, useState } from "react";
import type { Route } from "./+types/wiki";
import wikiSource from "../../examples/wiki/wiki.voyd?raw";
import stdPkgSource from "../../../../packages/std/src/pkg.voyd?raw";
import vxStdSource from "../../../../packages/std/src/vx.voyd?raw";
import "./wiki.css";

type DisposableRenderer = {
  dispose(): void;
};

type CompileFailure = {
  success: false;
  diagnostics: Array<{ message: string }>;
};

type CompileSuccess = {
  success: true;
  wasm: Uint8Array;
};

type CompileResult = CompileSuccess | CompileFailure;

export const prerender = true;

export function meta({}: Route.MetaArgs) {
  return [
    { title: "VX Wiki Demo" },
    {
      name: "description",
      content: "A browser VX wiki demo rendered from compiled Voyd through @voyd-lang/vx-dom.",
    },
  ];
}

export default function WikiDemoRoute() {
  const mountRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    let disposed = false;
    let renderer: DisposableRenderer | undefined;

    const mountCompiledWiki = async () => {
      try {
        const [{ createSdk }, { createVoydHost }, { createVoydVxAppRuntime, mountVxApp }] = await Promise.all([
          import("@voyd-lang/sdk/browser"),
          import("@voyd-lang/sdk/js-host"),
          import("@voyd-lang/vx-dom/browser"),
        ]);

        const { compile } = createSdk();
        const result = await compile({
          source: wikiSource,
          entryPath: "wiki.voyd",
          files: {
            "/std/pkg.voyd": stdPkgSource,
            "/std/vx.voyd": vxStdSource,
          },
        }) as CompileResult;
        if (!result.success) {
          throw new Error(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
        }

        const host = await createVoydHost({
          wasm: result.wasm,
          bufferSize: 256 * 1024,
        });
        const app = createVoydVxAppRuntime({
          host,
          exports: { subscriptions: "subscriptions" },
        });
        const componentStateApp = createVoydVxAppRuntime({
          host,
          exports: {
            init: "component_state_init",
            update: "component_state_update",
            view: "component_state_view",
          },
          viewReceivesModel: false,
        });
        if (disposed) return;

        container.textContent = "";
        const appContainer = document.createElement("div");
        const componentStateContainer = document.createElement("div");
        container.append(appContainer, componentStateContainer);

        const appRenderer = await mountVxApp({ container: appContainer, app });
        const componentStateRenderer = await mountVxApp({
          container: componentStateContainer,
          app: componentStateApp,
        });
        renderer = {
          dispose() {
            appRenderer.dispose();
            componentStateRenderer.dispose();
          },
        };
        setStatus("ready");
      } catch (reason) {
        if (disposed) return;
        setStatus("error");
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    };

    void mountCompiledWiki();

    return () => {
      disposed = true;
      renderer?.dispose();
    };
  }, []);

  return (
    <main className="min-h-[calc(100vh-72px)] bg-[var(--site-page-bg)]">
      {status === "loading" ? (
        <div className="wiki-demo-route-state">Compiling Voyd wiki...</div>
      ) : null}
      {status === "error" ? (
        <pre className="wiki-demo-route-state wiki-demo-route-error">{error}</pre>
      ) : null}
      <div ref={mountRef} />
    </main>
  );
}
