import type { BootstrapLoader, BootstrapPlan } from "../types.js";

export const vxSpaLoader: BootstrapLoader = {
  id: "vx-spa",
  description: "Vite + VX single-page app",
  plan: ({ packageName, voydVersion }): BootstrapPlan => ({
    template: "vx-spa",
    files: [
      {
        path: "index.html",
        content: indexHtml,
      },
      {
        path: "package.json",
        content: `${JSON.stringify(
          {
            name: packageName,
            private: true,
            type: "module",
            scripts: {
              dev: "vite",
              build: "vite build",
              preview: "vite preview",
              "voyd:build": "node scripts/compile-voyd.mjs",
              typecheck: "tsc --noEmit",
            },
            dependencies: {
              "@voyd-lang/sdk": `^${voydVersion}`,
              "@voyd-lang/vx-dom": `^${voydVersion}`,
            },
            devDependencies: {
              "@tailwindcss/vite": "^4.3.0",
              "@voyd-lang/cli": `^${voydVersion}`,
              tailwindcss: "^4.3.0",
              typescript: "^5.8.3",
              vite: "^8.0.0",
            },
          },
          null,
          2,
        )}\n`,
      },
      {
        path: "vite.config.mjs",
        content: viteConfig,
      },
      {
        path: "tsconfig.json",
        content: `${JSON.stringify(
          {
            compilerOptions: {
              target: "ES2022",
              useDefineForClassFields: true,
              module: "ESNext",
              lib: ["ES2022", "DOM", "DOM.Iterable"],
              types: ["vite/client", "node"],
              skipLibCheck: true,
              moduleResolution: "bundler",
              customConditions: ["development"],
              allowImportingTsExtensions: true,
              isolatedModules: true,
              moduleDetection: "force",
              noEmit: true,
              strict: true,
            },
            include: ["src"],
          },
          null,
          2,
        )}\n`,
      },
      {
        path: ".gitignore",
        content: gitIgnore,
      },
      {
        path: "scripts/compile-voyd.mjs",
        content: compileVoydScript,
      },
      {
        path: "src/main.ts",
        content: mainTs,
      },
      {
        path: "src/main.voyd",
        content: mainVoyd,
      },
      {
        path: "src/style.css",
        content: styleCss,
      },
    ],
    nextSteps: [
      "npm install",
      "npm run dev",
    ],
  }),
};

const indexHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="color-scheme" content="light dark" />
    <title>Voyd VX App</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
`;

const viteConfig = `import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { compileVoyd } from "./scripts/compile-voyd.mjs";

const voyd = () => ({
  name: "voyd",
  async buildStart() {
    await compileVoyd();
  },
  configureServer(server) {
    server.watcher.add("src");
  },
  async handleHotUpdate(ctx) {
    if (!ctx.file.endsWith(".voyd")) return;

    await compileVoyd();
    ctx.server.ws.send({ type: "full-reload" });
    return [];
  },
});

export default defineConfig({
  plugins: [voyd(), tailwindcss()],
});
`;

const compileVoydScript = `import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const entryPath = resolve(rootDir, "src/main.voyd");
const outPath = resolve(rootDir, "src/generated/main.wasm");
const adaptersPath = resolve(rootDir, "src/generated/voyd-adapters.ts");

export async function compileVoyd({ verbose = true } = {}) {
  await mkdir(dirname(outPath), { recursive: true });
  const wasm = await runVoyd(["--emit-wasm", "--opt", entryPath]);
  await writeFile(outPath, wasm);
  await runVoyd(["generate", "registry", entryPath, "--out", adaptersPath]);
  if (verbose) {
    console.log(\`compiled \${entryPath} -> \${outPath}\`);
  }
}

function runVoyd(args) {
  const command = process.platform === "win32" ? "voyd.cmd" : "voyd";

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];

    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      if (error && error.code === "ENOENT") {
        reject(new Error("Unable to find the voyd CLI. Run npm install before starting the app."));
        return;
      }
      reject(error);
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout));
        return;
      }

      const output = Buffer.concat(stderr).toString("utf8").trim();
      reject(new Error(output || \`voyd exited with status \${code}\`));
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await compileVoyd();
}
`;

const mainTs = `import { createVoydHost } from "@voyd-lang/sdk/js-host";
import { createVoydVxAppRuntime, mountVxApp } from "@voyd-lang/vx-dom/browser";
import wasmUrl from "./generated/main.wasm?url";
import { adapters } from "./generated/voyd-adapters";
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
    adapters,
  });
  const app = createVoydVxAppRuntime({ host });
  const mounted = await mountVxApp({ container: root, app });

  import.meta.hot?.dispose(() => mounted.dispose());
};

start().catch((reason) => {
  console.error(reason);
  root.textContent = reason instanceof Error ? reason.message : String(reason);
});
`;

const mainVoyd = `use std::enums::{ enum }
use std::string::type::String
use std::vx::all

obj Model {
  count: i32,
  title: String
}

enum Msg
  Increment
  Decrement
  Rename { value: String }

pub fn app() -> Program<Model, Msg>
  program<Model, Msg>(
    init: init,
    step: step,
    view: view
  )

pub fn init() -> Model
  Model {
    count: 0,
    title: "Voyd VX"
  }

pub fn step(model: Model, message: Msg) -> Program<Model, Msg>
  match(message)
    Msg::Increment:
      next(Model { count: model.count + 1, title: model.title })
    Msg::Decrement:
      next(Model { count: model.count - 1, title: model.title })
    Msg::Rename { value }:
      next(Model { count: model.count, title: value })

pub fn view(model: Model) -> Html<Msg>
  <main class="min-h-screen bg-slate-950 px-6 py-12 text-slate-100">
    <section class="mx-auto flex max-w-3xl flex-col gap-8">
      <header class="space-y-3">
        <p class="text-sm font-semibold uppercase tracking-wide text-cyan-300">Voyd VX</p>
        <h1 class="text-4xl font-bold text-white">Production starter</h1>
        <p class="max-w-2xl text-lg text-slate-300">
          Edit <code class="rounded bg-slate-800 px-2 py-1 text-cyan-200">src/main.voyd</code> and Vite will rebuild the WebAssembly module.
        </p>
      </header>

      <div class="rounded-lg border border-slate-800 bg-slate-900 p-6 shadow-xl shadow-cyan-950/30">
        <label class="block text-sm font-medium text-slate-300" for="title">App title</label>
        <input
          id="title"
          class="mt-2 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-white outline-none ring-cyan-400 transition focus:ring-2"
          value={model.title}
          on_input={(event: InputEvent) -> Msg => Msg::Rename { value: event.value }}
        />

        <div class="mt-6 flex items-center gap-4">
          <button class="rounded-md bg-slate-800 px-4 py-2 font-semibold text-white transition hover:bg-slate-700" on_click={Msg::Decrement {}}>
            -
          </button>
          <p class="min-w-24 text-center text-3xl font-bold text-cyan-200">{count_label(model.count)}</p>
          <button class="rounded-md bg-cyan-400 px-4 py-2 font-semibold text-slate-950 transition hover:bg-cyan-300" on_click={Msg::Increment {}}>
            +
          </button>
        </div>

        <p class="mt-6 text-slate-300">{model.title}</p>
      </div>
    </section>
  </main>

fn count_label(value: i32) -> String
  if
    value == -3: "-3"
    value == -2: "-2"
    value == -1: "-1"
    value == 0: "0"
    value == 1: "1"
    value == 2: "2"
    value == 3: "3"
    else: "many"
`;

const styleCss = `@import "tailwindcss";

@source "./**/*.voyd";

:root {
  font-family:
    Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI",
    sans-serif;
  color: #e2e8f0;
  background: #020617;
}

body {
  margin: 0;
  min-width: 320px;
  min-height: 100vh;
}

button,
input {
  font: inherit;
}
`;

const gitIgnore = `node_modules
dist
src/generated
.turbo
.DS_Store
`;
