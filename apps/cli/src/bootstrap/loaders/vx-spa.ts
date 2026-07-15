import type { BootstrapLoader, BootstrapPlan } from "../types.js";

export const vxSpaLoader: BootstrapLoader = {
  id: "vx-spa",
  description: "Vite + VX single-page app",
  plan: ({ packageName, voydVersion }): BootstrapPlan => ({
    template: "vx-spa",
    files: [
      { path: "index.html", content: indexHtml },
      { path: "package.json", content: packageJson(packageName, voydVersion) },
      { path: "vite.config.mjs", content: viteConfig },
      { path: "tsconfig.json", content: tsConfig },
      { path: ".gitignore", content: gitIgnore },
      { path: "scripts/compile-voyd.mjs", content: compileVoydScript },
      { path: "scripts/run-voyd.mjs", content: runVoydScript },
      { path: "src/main.ts", content: mainTs },
      { path: "src/main.voyd", content: mainVoyd },
      { path: "src/app.voyd", content: appModuleVoyd },
      { path: "src/app/model.voyd", content: modelVoyd },
      { path: "src/app/update.voyd", content: updateVoyd },
      { path: "src/app/ui.voyd", content: viewVoyd },
      { path: "src/style.css", content: styleCss },
    ],
    nextSteps: ["npm install", "npm run dev"],
  }),
};

const packageJson = (packageName: string, voydVersion: string): string =>
  `${JSON.stringify({
    name: packageName,
    private: true,
    type: "module",
    scripts: {
      dev: "vite",
      build: "npm run typecheck && vite build",
      preview: "vite preview",
      "voyd:build": "node scripts/compile-voyd.mjs",
      typecheck: "npm run voyd:build && tsc --noEmit",
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
  }, null, 2)}\n`;

const tsConfig = `${JSON.stringify({
  compilerOptions: {
    target: "ES2022",
    useDefineForClassFields: true,
    module: "ESNext",
    lib: ["ES2022", "DOM", "DOM.Iterable"],
    types: ["vite/client"],
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
}, null, 2)}\n`;

const indexHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="color-scheme" content="dark" />
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

let requestedCompilation = 0;
let completedCompilation = 0;
let compilationQueue = Promise.resolve();

async function compileLatest() {
  const request = ++requestedCompilation;
  compilationQueue = compilationQueue.catch(() => undefined).then(async () => {
    while (completedCompilation < requestedCompilation) {
      const compiling = requestedCompilation;
      await compileVoyd();
      completedCompilation = compiling;
    }
  });
  await compilationQueue;
  return request === requestedCompilation;
}

const voyd = () => ({
  name: "voyd",
  async buildStart() {
    await compileLatest();
  },
  configureServer(server) {
    server.watcher.add("src");
  },
  async handleHotUpdate({ file, server }) {
    if (file.replaceAll("\\\\", "/").includes("/src/generated/")) return [];
    if (!file.endsWith(".voyd")) return;
    if (await compileLatest()) server.ws.send({ type: "full-reload" });
    return [];
  },
});

export default defineConfig({
  plugins: [voyd(), tailwindcss()],
});
`;

const runVoydScript = `import { spawn } from "node:child_process";

export function runVoyd(args, { cwd }) {
  const command = process.platform === "win32" ? "voyd.cmd" : "voyd";
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];

    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => reject(missingCliError(error)));
    child.on("close", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout));
        return;
      }
      reject(new Error(Buffer.concat(stderr).toString("utf8").trim() ||
        "voyd exited with status " + code));
    });
  });
}

function missingCliError(error) {
  return error?.code === "ENOENT"
    ? new Error("Unable to find the voyd CLI. Run npm install before starting the app.")
    : error;
}
`;

const compileVoydScript = `import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runVoyd } from "./run-voyd.mjs";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const entryPath = resolve(rootDir, "src/main.voyd");
const outPath = resolve(rootDir, "src/generated/main.wasm");
const adaptersPath = resolve(rootDir, "src/generated/voyd-adapters.ts");
const stagingDir = resolve(rootDir, "src/generated/.staging");
const previousDir = resolve(rootDir, "src/generated/.previous");

export async function compileVoyd({ verbose = true } = {}) {
  await rm(stagingDir, { recursive: true, force: true });
  await mkdir(stagingDir, { recursive: true });
  const stagedWasm = resolve(stagingDir, "main.wasm");
  const stagedAdapters = resolve(stagingDir, "voyd-adapters.ts");
  await writeFile(stagedWasm, await runVoyd(["--emit-wasm", "--opt", entryPath], { cwd: rootDir }));
  await runVoyd(["generate", "registry", entryPath, "--out", stagedAdapters], { cwd: rootDir });
  await promoteGeneratedFiles([
    { staged: stagedWasm, live: outPath, previous: resolve(previousDir, "main.wasm") },
    { staged: stagedAdapters, live: adaptersPath, previous: resolve(previousDir, "voyd-adapters.ts") },
  ]);
  if (verbose) console.log("compiled " + entryPath + " -> " + outPath);
}

async function promoteGeneratedFiles(files) {
  await rm(previousDir, { recursive: true, force: true });
  await mkdir(previousDir, { recursive: true });
  const backedUp = [];
  try {
    for (const file of files) {
      try {
        await rename(file.live, file.previous);
        backedUp.push(file);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    for (const file of files) await rename(file.staged, file.live);
  } catch (error) {
    await Promise.all(files.map((file) => rm(file.live, { force: true })));
    await Promise.all(backedUp.map((file) => rename(file.previous, file.live)));
    throw error;
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
    await rm(previousDir, { recursive: true, force: true });
  }
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
if (!root) throw new Error("Missing #root element");

async function start() {
  const wasm = new Uint8Array(await (await fetch(wasmUrl)).arrayBuffer());
  const host = await createVoydHost({
    wasm,
    bufferSize: 256 * 1024,
    adapters,
  });
  const app = createVoydVxAppRuntime({ host });
  const mounted = await mountVxApp({ container: root, app });
  import.meta.hot?.dispose(() => mounted.dispose());
}

start().catch((error) => {
  console.error(error);
  root.textContent = error instanceof Error ? error.message : String(error);
});
`;

const mainVoyd = `use src::app::model::{ Model, initial_model }
use src::app::update::{ Msg, step }
use src::app::ui::view
use std::vx::all

pub fn app() -> Program<Model, Msg>
  program({ init: initial_model, step: step, view })
`;

const appModuleVoyd = `pub self::model
pub self::update
pub self::ui
`;

const modelVoyd = `use std::string::type::String

pub obj Model {
  count: i32,
  title: String
}

pub fn initial_model() -> Model
  Model { count: 0, title: "Voyd VX" }

pub fn with_count(model: Model, count: i32) -> Model
  Model { count: count, title: model.title }

pub fn with_title(model: Model, title: String) -> Model
  Model { count: model.count, title: title }
`;

const updateVoyd = `use super::model::{ Model, with_count, with_title }
use std::enums::{ enum }
use std::string::type::String
use std::vx::{ Program, next }

pub enum Msg
  Increment
  Decrement
  Rename { value: String }

pub fn step(model: Model, message: Msg) -> Program<Model, Msg>
  match(message)
    Msg::Increment:
      next(with_count(model, model.count + 1))
    Msg::Decrement:
      next(with_count(model, model.count - 1))
    Msg::Rename { value }:
      next(with_title(model, value))
`;

const viewVoyd = `use super::model::Model
use super::update::Msg
use std::number::cast::to_string
use std::string::type::String
use std::vx::all

pub fn view(model: Model) -> Html<Msg>
  <main class="min-h-screen bg-slate-950 px-6 py-12 text-slate-100">
    <section class="mx-auto flex max-w-3xl flex-col gap-8">
      <header class="space-y-3">
        <p class="text-sm font-semibold uppercase tracking-wide text-cyan-300">Voyd VX</p>
        <h1 class="text-4xl font-bold text-white">A clean place to start</h1>
        <p class="max-w-2xl text-lg text-slate-300">
          Application state, updates, and views live in focused modules under <code class="rounded bg-slate-800 px-2 py-1 text-cyan-200">src/app</code>.
        </p>
      </header>
      <Counter model={model} />
    </section>
  </main>

fn Counter({ model: Model }) -> Html<Msg>
  <div class="rounded-lg border border-slate-800 bg-slate-900 p-6 shadow-xl shadow-cyan-950/30">
    <TitleField title={model.title} />
    <div class="mt-6 flex items-center gap-4">
      <CounterButton label="−" message={Msg::Decrement {}} />
      <p class="min-w-24 text-center text-3xl font-bold text-cyan-200">{to_string(model.count)}</p>
      <CounterButton label="+" message={Msg::Increment {}} />
    </div>
    <p class="mt-6 text-slate-300">{model.title}</p>
  </div>

fn TitleField({ title: String }) -> Html<Msg>
  <label class="block text-sm font-medium text-slate-300">
    App title
    <input
      class="mt-2 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-white outline-none ring-cyan-400 transition focus:ring-2"
      value={title}
      on_input={(event: InputEvent) -> Msg => Msg::Rename { value: event.value }}
    />
  </label>

fn CounterButton({ label: String, message: Msg }) -> Html<Msg>
  <button
    class="rounded-md bg-cyan-400 px-4 py-2 font-semibold text-slate-950 transition hover:bg-cyan-300"
    type="button"
    on_click={message}
  >
    {label}
  </button>
`;

const styleCss = `@import "tailwindcss";

@source "./**/*.voyd";

:root {
  font-family: Inter, ui-sans-serif, system-ui, sans-serif;
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
