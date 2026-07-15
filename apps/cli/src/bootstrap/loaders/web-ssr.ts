import type { BootstrapLoader, BootstrapPlan } from "../types.js";

export const webSsrLoader: BootstrapLoader = {
  id: "web-ssr",
  description: "SSR web app with Tailwind",
  plan: ({ packageName, voydVersion }): BootstrapPlan => ({
    template: "web-ssr",
    files: [
      { path: "package.json", content: packageJson(packageName, voydVersion) },
      { path: "vite.config.mjs", content: viteConfig },
      { path: "tsconfig.json", content: tsConfig },
      { path: ".gitignore", content: gitIgnore },
      { path: "README.md", content: readme(packageName) },
      { path: "scripts/run-voyd.mjs", content: runVoydScript },
      { path: "scripts/compile-client.mjs", content: compileClientScript },
      { path: "scripts/check-voyd.mjs", content: checkVoydScript },
      { path: "scripts/serve.mjs", content: serveScript },
      { path: "scripts/watch-source.mjs", content: watchSourceScript },
      { path: "scripts/dev.mjs", content: devScript },
      { path: "src/client.ts", content: clientTs },
      { path: "src/client.voyd", content: clientVoyd },
      { path: "src/main.voyd", content: mainVoyd },
      { path: "src/app.voyd", content: appModuleVoyd },
      { path: "src/app/model.voyd", content: modelVoyd },
      { path: "src/app/update.voyd", content: updateVoyd },
      { path: "src/app/ui.voyd", content: viewVoyd },
      { path: "src/server.voyd", content: serverModuleVoyd },
      { path: "src/server/articles.voyd", content: articlesVoyd },
      { path: "src/server/page.voyd", content: pageVoyd },
      { path: "src/style.css", content: styleCss },
      { path: "data/articles/home.md", content: homeArticle },
      { path: "data/articles/voyd.md", content: voydArticle },
      { path: "data/articles/webassembly.md", content: webassemblyArticle },
      { path: "public/.gitkeep", content: "" },
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
      dev: "node scripts/dev.mjs",
      build: "npm run typecheck && vite build && node scripts/check-voyd.mjs",
      start: "node scripts/serve.mjs",
      "voyd:check": "node scripts/check-voyd.mjs",
      typecheck: "tsc --noEmit",
    },
    dependencies: {
      "@voyd-lang/sdk": `^${voydVersion}`,
      "@voyd-lang/vx-dom": `^${voydVersion}`,
      "@voyd-lang/web": `^${voydVersion}`,
    },
    devDependencies: {
      "@tailwindcss/vite": "^4.3.0",
      "@types/node": "^22.5.1",
      "@voyd-lang/cli": `^${voydVersion}`,
      tailwindcss: "^4.3.0",
      typescript: "^5.8.3",
      vite: "^8.0.0",
    },
  }, null, 2)}\n`;

const tsConfig = `${JSON.stringify({
  compilerOptions: {
    target: "ES2022",
    module: "ESNext",
    lib: ["ES2022", "DOM", "DOM.Iterable"],
    types: ["node", "vite/client"],
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

const viteConfig = `import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { compileClient } from "./scripts/compile-client.mjs";

const voydClient = () => ({
  name: "voyd-client",
  async buildStart() {
    await compileClient();
  },
  configureServer(server) {
    server.watcher.add("src");
  },
  async handleHotUpdate({ file, server }) {
    if (!file.endsWith(".voyd")) return;
    await compileClient();
    server.ws.send({ type: "full-reload" });
    return [];
  },
});

export default defineConfig({
  plugins: [voydClient(), tailwindcss()],
  publicDir: false,
  build: {
    outDir: "public",
    emptyOutDir: false,
    rollupOptions: {
      input: "src/client.ts",
      output: {
        entryFileNames: "assets/client.js",
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
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

const compileClientScript = `import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runVoyd } from "./run-voyd.mjs";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const entryPath = resolve(rootDir, "src/client.voyd");
const outPath = resolve(rootDir, "src/generated/client.wasm");

export async function compileClient({ verbose = true } = {}) {
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, await runVoyd(["--emit-wasm", "--opt", entryPath], { cwd: rootDir }));
  if (verbose) console.log("compiled " + entryPath + " -> " + outPath);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await compileClient();
}
`;

const checkVoydScript = `import { createSdk } from "@voyd-lang/sdk";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compileClient } from "./compile-client.mjs";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const result = await createSdk().compile({
  entryPath: resolve(rootDir, "src/main.voyd"),
  optimize: true,
  runtimeDiagnostics: true,
});

if (!result.success) {
  console.error(result.diagnostics.map(formatDiagnostic).join("\\n"));
  process.exit(1);
}

await compileClient();
console.log("Voyd server and client compiled successfully.");

function formatDiagnostic(diagnostic) {
  const location = diagnostic.location
    ? diagnostic.location.filePath + ":" + diagnostic.location.start.line + ":" + diagnostic.location.start.column
    : diagnostic.file ?? "voyd";
  return location + " " + diagnostic.severity + ": " + diagnostic.message;
}
`;

const serveScript = `import { createSdk } from "@voyd-lang/sdk";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const entryPath = resolve(rootDir, "src/main.voyd");
process.chdir(rootDir);

export async function serve({
  host = process.env.HOST ?? process.env.VOYD_WEB_HOST ?? "127.0.0.1",
  port = readPort(),
  optimize = true,
} = {}) {
  const result = await createSdk().serveWebApp({
    entryPath,
    host,
    port,
    optimize,
    runtimeDiagnostics: true,
    run: {
      bufferSize: 1024 * 1024,
      defaultAdapters: { runtime: "node" },
    },
  });
  if (!result.success) {
    throw new Error(result.diagnostics.map((diagnostic) => diagnostic.message).join("\\n"));
  }
  return result;
}

export async function checkServer({ optimize = false } = {}) {
  const result = await createSdk().compile({
    entryPath,
    optimize,
    runtimeDiagnostics: true,
  });
  if (!result.success) {
    throw new Error(result.diagnostics.map((diagnostic) => diagnostic.message).join("\\n"));
  }
}

function readPort() {
  const parsed = Number.parseInt(process.env.PORT ?? process.env.VOYD_WEB_PORT ?? "3000", 10);
  return Number.isFinite(parsed) ? parsed : 3000;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = await serve();
  console.log("Voyd app ready at " + app.url);
  let closing = false;
  const keepAlive = setInterval(() => undefined, 1_000_000_000);
  const shutdown = new Promise((resolveShutdown) => {
    const close = (signal) => {
      if (closing) return;
      closing = true;
      clearInterval(keepAlive);
      void app.close(signal).finally(resolveShutdown);
    };
    process.once("SIGINT", () => close("SIGINT"));
    process.once("SIGTERM", () => close("SIGTERM"));
  });
  const unexpectedClose = app.closed.then(
    () => {
      if (!closing) throw new Error("Voyd server stopped unexpectedly");
    },
    (error) => {
      if (!closing) throw error;
    },
  );
  try {
    await Promise.race([shutdown, unexpectedClose]);
  } finally {
    clearInterval(keepAlive);
  }
}
`;

const watchSourceScript = `import { readdirSync, statSync, watch } from "node:fs";
import { join } from "node:path";

export function watchSource(root, onChange) {
  const watchers = new Map();
  const retryAttempts = new Map();
  const retryTimers = new Map();
  let closed = false;
  const watchTree = (directory) => {
    if (closed || !isDirectory(directory)) return;
    watchDirectory(directory);
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      scheduleWatchRetry(directory, error);
      return;
    }
    entries
      .filter((entry) => entry.isDirectory())
      .forEach((entry) => watchTree(join(directory, entry.name)));
  };
  const watchDirectory = (directory) => {
    if (closed || watchers.has(directory)) return;
    try {
      const watcher = watch(directory, (_event, filename) => {
        retryAttempts.delete(directory);
        if (!filename) {
          reconcileWatchers();
          onChange();
          return;
        }
        const path = join(directory, filename.toString());
        if (isDirectory(path)) {
          watchTree(path);
          onChange();
          return;
        }
        reconcileWatchers();
        onChange(path);
      });
      watchers.set(directory, watcher);
      watcher.on("error", (error) => handleWatcherError(directory, watcher, error));
    } catch (error) {
      scheduleWatchRetry(directory, error);
    }
  };
  const handleWatcherError = (directory, watcher, error) => {
    console.error("Source watcher failed for " + directory, error);
    watcher.close();
    if (watchers.get(directory) === watcher) watchers.delete(directory);
    scheduleWatchRetry(directory);
    onChange();
  };
  const scheduleWatchRetry = (directory, error) => {
    if (closed || retryTimers.has(directory)) return;
    const attempt = retryAttempts.get(directory) ?? 0;
    if (error && attempt === 0) {
      console.error("Unable to watch source directory " + directory, error);
    }
    retryAttempts.set(directory, attempt + 1);
    const timer = setTimeout(() => {
      retryTimers.delete(directory);
      if (isDirectory(directory)) watchDirectory(directory);
      reconcileWatchers();
    }, Math.min(100 * (2 ** attempt), 5000));
    retryTimers.set(directory, timer);
  };
  const reconcileWatchers = () => {
    if (closed) return;
    watchers.forEach((watcher, directory) => {
      if (isDirectory(directory)) return;
      watcher.close();
      watchers.delete(directory);
    });
    watchTree(root);
  };
  watchTree(root);
  return () => {
    closed = true;
    watchers.forEach((watcher) => watcher.close());
    retryTimers.forEach((timer) => clearTimeout(timer));
    watchers.clear();
    retryAttempts.clear();
    retryTimers.clear();
  };
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
`;

const devScript = `import { rename, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkServer, serve } from "./serve.mjs";
import { watchSource } from "./watch-source.mjs";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const sourceDir = resolve(rootDir, "src");
const stagedPublicDir = resolve(rootDir, ".voyd-dev/public");
const liveAssetsDir = resolve(rootDir, "public/assets");
const previousAssetsDir = resolve(rootDir, ".voyd-dev/previous-assets");
let app;
let rebuilding = false;
let rebuildRequested = false;

const stopWatching = watchSource(sourceDir, (file) => {
  if (file && !/\\.(voyd|ts|css)$/.test(file)) return;
  void queueRebuild();
});
await queueRebuild({ failFast: true });

async function queueRebuild({ failFast = false } = {}) {
  rebuildRequested = true;
  if (rebuilding) return;
  rebuilding = true;
  try {
    while (rebuildRequested) {
      rebuildRequested = false;
      try {
        await rebuild();
      } catch (error) {
        if (failFast) throw error;
        console.error(error);
      }
    }
  } finally {
    rebuilding = false;
  }
}

async function rebuild() {
  await checkServer({ optimize: false });
  await rm(stagedPublicDir, { recursive: true, force: true });
  await run("vite", [
    "build",
    "--mode", "development",
    "--outDir", stagedPublicDir,
    "--emptyOutDir",
  ]);
  await checkServer({ optimize: false });
  if (app) await app.close("restart").catch(() => undefined);
  const nextApp = await serve({ optimize: false });
  try {
    await promoteAssets();
  } catch (error) {
    await nextApp.close("asset-promotion-failed").catch(() => undefined);
    throw error;
  }
  app = nextApp;
  console.log("Voyd app ready at " + app.url);
}

async function promoteAssets() {
  const stagedAssetsDir = resolve(stagedPublicDir, "assets");
  await rm(previousAssetsDir, { recursive: true, force: true });
  await rename(liveAssetsDir, previousAssetsDir).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
  try {
    await rename(stagedAssetsDir, liveAssetsDir);
  } catch (error) {
    await rename(previousAssetsDir, liveAssetsDir).catch(() => undefined);
    throw error;
  }
  await rm(previousAssetsDir, { recursive: true, force: true });
  await rm(stagedPublicDir, { recursive: true, force: true });
}

function run(name, args) {
  const command = process.platform === "win32" ? name + ".cmd" : name;
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: rootDir, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0
      ? resolveRun()
      : reject(new Error(name + " exited with code " + code)));
  });
}

async function shutdown() {
  stopWatching();
  if (app) await app.close("shutdown").catch(() => undefined);
}

process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
`;

const clientTs = `import { createVoydHost } from "@voyd-lang/sdk/js-host";
import {
  createVoydVxAppRuntime,
  hydrateVxApp,
  readVoydHydrationRoot,
} from "@voyd-lang/vx-dom/browser";
import wasmUrl from "./generated/client.wasm?url";
import "./style.css";

const hydration = readVoydHydrationRoot("article-editor");

async function start() {
  const wasm = new Uint8Array(await (await fetch(wasmUrl)).arrayBuffer());
  const host = await createVoydHost({
    wasm,
    bufferSize: 1024 * 1024,
    defaultAdapters: { runtime: "browser" },
  });
  const app = createVoydVxAppRuntime({ host, initialModel: hydration.model });
  const mounted = await hydrateVxApp({
    container: hydration.container,
    app,
    onHydrationMismatch: import.meta.env.MODE === "development"
      ? (mismatch) => console.warn("Voyd hydration mismatch", mismatch)
      : undefined,
  });
  import.meta.hot?.dispose(() => mounted.dispose());
}

start().catch((error) => {
  console.error(error);
  const notice = document.createElement("p");
  notice.setAttribute("role", "alert");
  notice.className = "m-5 rounded-md border border-rose-300 bg-rose-50 p-3 text-sm text-rose-800";
  notice.textContent = "Interactive features could not start. You can still edit and submit this form.";
  hydration.container.prepend(notice);
});
`;

const mainVoyd = `use src::server::articles::{
  article_slug_from,
  form_body,
  load_article,
  request_body,
  save_article
}
use src::server::page::article_page
use pkg::web::all
use std::env::self as env
use std::error::{ HostError, IoError }
use std::fs::self as fs
use std::http::{ HttpError, server }
use std::result::types::all
use std::task::self as tasks

pub fn main(): (server::HttpServer, tasks::TaskRuntime, env::Env, fs::Fs) -> i32
  let result = serve(
    port: app_port(),
    host: app_host(),
    shutdown_timeout: 30000,
    max_body_bytes: 65536
  ) routes():
    adopt(serve_dir("./public"))

    get("/") do:
      article_page(load_article("home"))

    get("/wiki") do(ctx: Context):
      article_response(ctx)

    get("/wiki/:slug") do(ctx: Context):
      article_response(ctx)

    post("/wiki/:slug/body") do(ctx: Context):
      save_body_response(ctx)

    post("/wiki/:slug") do(ctx: Context):
      save_form_response(ctx)

  match(result)
    Ok<Unit>:
      0
    Err<HostError> { error }:
      -error.code

fn save_body_response(ctx: Context): fs::Fs -> Response
  match(article_slug_from(ctx))
    Some<String> { value: slug }:
      match(request_body(ctx))
        Ok<String> { value }:
          saved_body_response(slug: slug, body: value)
        Err<HttpError> { error }:
          Response::bad_request().text(error.message)
    None:
      invalid_request("invalid article slug")

fn saved_body_response({ slug: String, body: String }): fs::Fs -> Response
  match(save_article(slug: slug, body: body))
    Ok:
      Response::ok().text("saved")
    Err<IoError> { error }:
      Response::internal_server_error().text(error.message)

fn save_form_response(ctx: Context): fs::Fs -> Response
  match(article_slug_from(ctx))
    Some<String> { value: slug }:
      match(request_body(ctx))
        Ok<String> { value }:
          match(form_body(value))
            Some<String> { value: body }:
              saved_form_response(slug: slug, body: body)
            None:
              invalid_request("missing body form field")
        Err<HttpError> { error }:
          Response::bad_request().text(error.message)
    None:
      invalid_request("invalid article slug")

fn saved_form_response({ slug: String, body: String }): fs::Fs -> Response
  match(save_article(slug: slug, body: body))
    Ok { value }:
      article_page(value)
    Err<IoError> { error }:
      Response::internal_server_error().text(error.message)

fn article_response(ctx: Context): fs::Fs -> Response
  match(article_slug_from(ctx))
    Some<String> { value }:
      article_page(load_article(value))
    None:
      invalid_request("invalid article slug")

fn invalid_request(message: String) -> Response
  Response::bad_request().text(message)

fn app_port(): env::Env -> i32
  env::get_int("VOYD_WEB_PORT") ?? 3000

fn app_host(): env::Env -> String
  env::get("VOYD_WEB_HOST") ?? "127.0.0.1"
`;

const clientVoyd = `use src::app::model::{ Model, empty_model }
use src::app::update::{ Msg, step }
use src::app::ui::view
use std::vx::all

pub fn app() -> Program<Model, Msg>
  program({ init: empty_model, step: step, view })
`;

const appModuleVoyd = `pub self::model
pub self::update
pub self::ui
`;

const modelVoyd = `use std::string::type::String

pub obj Model {
  slug: String,
  title: String,
  body: String,
  saved_body: String,
  preview_open: bool,
  save_count: i32,
  saving: bool,
  save_failed: bool
}

pub fn initial_model({ slug: String, title: String, body: String }) -> Model
  Model {
    slug: slug,
    title: title,
    body: body,
    saved_body: body,
    preview_open: true,
    save_count: 0,
    saving: false,
    save_failed: false
  }

pub fn empty_model() -> Model
  initial_model(slug: "home", title: "Mini Voydpedia", body: String::init())

pub fn with_body(model: Model, body: String) -> Model
  copy(model, body: body)

pub fn reset(model: Model) -> Model
  copy(model, body: model.saved_body, save_failed: false)

pub fn toggle_preview(model: Model) -> Model
  copy(model, preview_open: not model.preview_open)

pub fn start_saving(model: Model) -> Model
  copy(model, saving: true, save_failed: false)

pub fn finish_saving(model: Model, succeeded: bool) -> Model
  copy(
    model,
    saved_body: if succeeded then: model.body else: model.saved_body,
    save_count: if succeeded then: model.save_count + 1 else: model.save_count,
    saving: false,
    save_failed: not succeeded
  )

pub fn is_dirty(model: Model) -> bool
  not (model.body == model.saved_body)

pub fn can_save(model: Model) -> bool
  is_dirty(model) and not model.saving

fn copy(model: Model, {
  body?: String,
  saved_body?: String,
  preview_open?: bool,
  save_count?: i32,
  saving?: bool,
  save_failed?: bool
}) -> Model
  Model {
    slug: model.slug,
    title: model.title,
    body: body ?? model.body,
    saved_body: saved_body ?? model.saved_body,
    preview_open: preview_open ?? model.preview_open,
    save_count: save_count ?? model.save_count,
    saving: saving ?? model.saving,
    save_failed: save_failed ?? model.save_failed
  }
`;

const updateVoyd = `use super::model::{
  Model,
  can_save,
  finish_saving,
  reset,
  start_saving,
  toggle_preview,
  with_body
}
use std::enums::{ enum }
use std::error::HostError
use std::http::{ Body, Response }
use std::http::client::self as http_client
use std::result::types::all
use std::string::type::String
use std::task::self as tasks
use std::vx::all

pub enum Msg
  Edit { value: String }
  Save
  SaveFinished { succeeded: bool }
  Reset
  TogglePreview

pub fn step(
  model: Model,
  message: Msg
): (http_client::HttpClient, tasks::TaskRuntime) -> Program<Model, Msg>
  match(message)
    Msg::Edit { value }:
      next(with_body(model, value))
    Msg::Reset:
      next(reset(model))
    Msg::TogglePreview:
      next(toggle_preview(model))
    Msg::Save:
      save(model)
    Msg::SaveFinished { succeeded }:
      next(finish_saving(model, succeeded))

fn save(model: Model): (http_client::HttpClient, tasks::TaskRuntime) -> Program<Model, Msg>
  if not can_save(model):
    return next(model)
  program<Model, Msg>(
    model: start_saving(model),
    commands: Cmd<Msg>::task(
      work: () -> bool => save_article(slug: model.slug, body: model.body),
      handler: (succeeded: bool) -> Msg => Msg::SaveFinished { succeeded: succeeded }
    )
  )

fn save_article({ slug: String, body: String }): http_client::HttpClient -> bool
  let response: Result<Response, HostError> = http_client::post(
    url: "/wiki/".concat(slug).concat("/body"),
    body: Body::text(body)
  )
  match(response)
    Ok<Response> { value }:
      value.is_success()
    Err<HostError>:
      false
`;

const viewVoyd = `use super::model::{ Model, can_save, is_dirty }
use super::update::Msg
use std::array::Array
use std::msgpack::MsgPack
use std::number::cast::to_string
use std::string::type::String
use std::vx::all

pub fn view(model: Model) -> Html<Msg>
  editor(model, interactive: true)

pub fn static_view(model: Model) -> Html<Msg>
  editor(model, interactive: false)

fn editor(model: Model, { interactive: bool }) -> Html<Msg>
  <form
    class="mx-auto flex w-full max-w-5xl flex-col px-5 py-8 lg:px-10"
    action={"/wiki/".concat(model.slug)}
    method="post"
    on_submit={on_submit_with(
      options: EventOptions {
        prevent_default: true,
        stop_propagation: false,
        capture: false,
        passive: false
      },
      message: Msg::Save {}
    )}
  >
    <EditorHeader model={model} />
    <EditorStats model={model} />
    <div class={editor_grid_class(model)}>
      <BodyEditor model={model} interactive={interactive} />
      <Preview model={model} />
    </div>
  </form>

fn EditorHeader({ model: Model }) -> Html<Msg>
  <header class="flex flex-col gap-4 border-b border-zinc-200 pb-6 md:flex-row md:items-end md:justify-between">
    <div>
      <p class="text-sm font-medium uppercase tracking-wide text-emerald-700">Local file article</p>
      <h1 class="mt-2 text-4xl font-semibold tracking-tight">{model.title}</h1>
      <p class="mt-3 max-w-2xl text-zinc-600">Rendered once by the server, then hydrated from the same Voyd view.</p>
    </div>
    <div class="flex flex-wrap items-center gap-3">
      <span class={status_class(model)}>{status_label(model)}</span>
      <button class="rounded-md border border-zinc-300 bg-white px-4 py-2 font-semibold" type="button" disabled={not can_save(model)} on_click={Msg::Reset {}}>Reset</button>
      <button class="rounded-md border border-emerald-700 bg-white px-4 py-2 font-semibold text-emerald-800" type="button" disabled={model.saving} on_click={Msg::TogglePreview {}}>{preview_label(model)}</button>
      <button class="rounded-md bg-emerald-700 px-4 py-2 font-semibold text-white disabled:bg-zinc-400" type="submit" disabled={model.saving}>{save_label(model)}</button>
    </div>
  </header>

fn EditorStats({ model: Model }) -> Html<Msg>
  <section class="grid gap-4 border-b border-zinc-200 py-4 text-sm text-zinc-600 sm:grid-cols-3">
    <Stat label="Characters" value={to_string(model.body.byte_len())} />
    <Stat label="Local state" value={dirty_label(model)} />
    <Stat label="Client saves" value={to_string(model.save_count)} />
  </section>

fn Stat({ label: String, value: String }) -> Html<Msg>
  <div class="rounded-md border border-zinc-200 bg-white px-3 py-2">
    <div class="text-xs font-medium uppercase tracking-wide text-zinc-500">{label}</div>
    <div class="mt-1 font-semibold text-zinc-950">{value}</div>
  </div>

fn BodyEditor({ model: Model, interactive: bool }) -> Html<Msg>
  <label class="mt-8 flex min-h-[32rem] flex-1 flex-col">
    <span class="mb-3 text-sm font-medium text-zinc-700">Article body</span>
    {BodyTextarea(model: model, interactive: interactive)}
  </label>

fn BodyTextarea({ model: Model, interactive: bool }) -> Html<Msg>
  let ~attrs = [
    class("min-h-[32rem] flex-1 resize-y rounded-md border border-zinc-300 bg-white p-5 font-mono text-sm leading-7 outline-none focus:border-emerald-600"),
    attr(name: "name", value: "body"),
    attr(name: "spellcheck", value: "true"),
    value(model.body),
    disabled(model.saving)
  ]
  if interactive:
    attrs.push(event_payload_handler<InputEvent, Msg>(
      name: "input",
      handler: (event: InputEvent) -> Msg => Msg::Edit { value: event.value }
    ))
  element(tag: "textarea", attrs: attrs, children: [text(model.body)])

fn Preview({ model: Model }) -> Html<Msg>
  if model.preview_open:
    <aside class="mt-8 rounded-md border border-zinc-200 bg-white p-5 shadow-sm">
      <p class="text-xs font-medium uppercase tracking-wide text-emerald-700">Live preview</p>
      <h2 class="mt-3 text-2xl font-semibold">{model.title}</h2>
      <pre class="mt-4 whitespace-pre-wrap rounded-md bg-zinc-50 p-4 text-sm leading-7">{model.body}</pre>
    </aside>
  else:
    fragment(Array<MsgPack>::init())

fn status_label(model: Model) -> String
  if model.saving:
    return "Saving..."
  if model.save_failed:
    return "Save failed"
  if is_dirty(model):
    return "Unsaved changes"
  "Saved"

fn status_class(model: Model) -> String
  if model.save_failed:
    return "rounded-full bg-rose-100 px-3 py-1 text-sm font-medium text-rose-800"
  if model.saving:
    return "rounded-full bg-sky-100 px-3 py-1 text-sm font-medium text-sky-800"
  if is_dirty(model):
    return "rounded-full bg-amber-100 px-3 py-1 text-sm font-medium text-amber-800"
  "rounded-full bg-emerald-100 px-3 py-1 text-sm font-medium text-emerald-800"

fn dirty_label(model: Model) -> String
  if is_dirty(model) then: "Unsaved" else: "Saved"

fn preview_label(model: Model) -> String
  if model.preview_open then: "Hide preview" else: "Show preview"

fn save_label(model: Model) -> String
  if model.saving then: "Saving..." else: "Save"

fn editor_grid_class(model: Model) -> String
  if model.preview_open:
    "grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]"
  else:
    "grid gap-6"
`;

const articlesVoyd = `use pkg::web::{ Context, parse_query }
use std::error::IoError
use std::fs::self as fs
use std::fs::{ read_string, write_string }
use std::http::HttpError
use std::optional::types::all
use std::path::Path
use std::result::types::all
use std::string::type::String

pub type Article = {
  slug: String,
  title: String,
  body: String
}

pub fn load_article(slug: String): fs::Fs -> Article
  let clean = canonical_slug(slug)
  match(read_string(article_path(clean)))
    Ok<String> { value }:
      article(clean, value)
    Err<IoError>:
      article(clean, "# New article\\n\\nStart writing, then click Save.")

pub fn save_article({ slug: String, body: String }): fs::Fs -> Result<Article, IoError>
  match(write_string(article_path(slug), body))
    Ok<Unit>:
      Ok<Article> { value: article(slug, body) }
    Err<IoError> { error }:
      Err<IoError> { error: error }

pub fn article_slug_from(ctx: Context) -> Option<String>
  match(ctx.param("slug"))
    Some<String> { value }:
      valid_slug(value)
    None:
      match(ctx.query_value("slug"))
        Some<String> { value }:
          valid_slug(value)
        None:
          Some<String> { value: "home" }

pub fn request_body(ctx: Context) -> Result<String, HttpError>
  ctx.request.body.as_text()

pub fn form_body(input: String) -> Option<String>
  parse_query(input).get("body")

fn article(slug: String, body: String) -> Article
  { slug: slug, title: title_for(slug), body: body }

fn article_path(slug: String) -> Path
  Path::new("./data/articles").join(canonical_slug(slug).concat(".md"))

fn canonical_slug(value: String) -> String
  valid_slug(value) ?? "home"

fn valid_slug(value: String) -> Option<String>
  let slug = value.trimmed().lowered()
  if slug.is_empty() or slug.contains(where: (rune: i32) -> bool => not is_slug_rune(rune)):
    return None {}
  Some<String> { value: slug }

fn is_slug_rune(rune: i32) -> bool
  (rune >= 97 and rune <= 122) or (rune >= 48 and rune <= 57) or rune == 45 or rune == 95

fn title_for(slug: String) -> String
  if slug == "home" then: "Mini Voydpedia" else: slug
`;

const pageVoyd = `use super::articles::Article
use src::app::model::{ Model, initial_model }
use src::app::update::Msg
use src::app::ui::static_view
use pkg::web::{ Response, document, hydrate_named }
use std::string::type::String
use std::vx::all

pub fn article_page(article: Article) -> Response
  let model = initial_model(slug: article.slug, title: article.title, body: article.body)
  Response::ok()
    .with(header: "content-type", value: "text/html; charset=utf-8")
    .text(document<Msg, Model>(
      view: page_view(model),
      hydrate: hydrate_named<Model>(
        id: "article-editor",
        target: "#article-editor",
        entry: "/assets/client.js",
        model: model
      )
    ))

fn page_view(model: Model) -> Html<Msg>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{model.title}</title>
      <link rel="stylesheet" href="/assets/client.css" />
    </head>
    <body class="min-h-screen bg-stone-50 text-zinc-950 antialiased">
      <main class="grid min-h-screen grid-cols-1 lg:grid-cols-[18rem_minmax(0,1fr)]">
        <Sidebar active_slug={model.slug} />
        <div id="article-editor">{static_view(model)}</div>
      </main>
    </body>
  </html>

fn Sidebar({ active_slug: String }) -> Html<Msg>
  <aside class="border-b border-zinc-200 bg-white px-5 py-6 lg:border-b-0 lg:border-r">
    <a class="block text-lg font-semibold text-emerald-700" href="/">Mini Voydpedia</a>
    <nav class="mt-8 grid gap-2 text-sm">
      <NavLink href="/" label="Home" active={active_slug == "home"} />
      <NavLink href="/wiki/voyd" label="Voyd" active={active_slug == "voyd"} />
      <NavLink href="/wiki/webassembly" label="WebAssembly" active={active_slug == "webassembly"} />
    </nav>
    <form class="mt-8 flex gap-2" action="/wiki" method="get">
      <input class="min-w-0 flex-1 rounded-md border border-zinc-300 px-3 py-2" name="slug" placeholder="article-slug" />
      <button class="rounded-md bg-zinc-950 px-3 py-2 text-white" type="submit">Open</button>
    </form>
  </aside>

fn NavLink({ href: String, label: String, active: bool }) -> Html<Msg>
  <a class={nav_class(active)} href={href}>{label}</a>

fn nav_class(active: bool) -> String
  if active:
    "rounded-md bg-emerald-50 px-3 py-2 font-medium text-emerald-800"
  else:
    "rounded-md px-3 py-2 text-zinc-600 hover:bg-zinc-100"
`;

const serverModuleVoyd = `pub self::articles
pub self::page
`;

const styleCss = `@import "tailwindcss";

@source "./**/*.voyd";

:root {
  font-family: Inter, ui-sans-serif, system-ui, sans-serif;
}

body {
  margin: 0;
  min-width: 320px;
}

button,
input,
textarea {
  font: inherit;
}
`;

const homeArticle = `# Mini Voydpedia

This article editor is rendered on the server and hydrated in the browser from
the same shared Voyd view.
`;

const voydArticle = `# Voyd

Voyd is a programming language that compiles to WebAssembly.
`;

const webassemblyArticle = `# WebAssembly

WebAssembly is the portable compilation target used by the server and browser.
`;

const gitIgnore = `node_modules
public/assets
src/generated
.voyd-dev
dist
.turbo
.DS_Store
data/articles/*.md
!data/articles/home.md
!data/articles/voyd.md
!data/articles/webassembly.md
`;

const readme = (packageName: string) => `# ${packageName}

This is a server-rendered Voyd application with a hydrated VX editor.

## Architecture

- \`src/main.voyd\` owns HTTP routes and server startup.
- \`src/server\` owns persistence and the server-rendered document shell.
- \`src/app\` owns the shared model, update logic, and exact markup. Its
  \`static_view\` omits retained browser handlers while sharing the same editor
  implementation as the interactive \`view\`.
- \`src/client.voyd\` is the browser Program entrypoint.
- \`src/client.ts\` is the generic Wasm hydration bridge.

Code inside \`#article-editor\` must render identically on the server and client.
The development bridge reports hydration differences without preventing recovery.

## Commands

- \`npm run dev\` rebuilds both Wasm entrypoints and restarts the server when
  Voyd, TypeScript, or CSS sources change.
- \`npm run build\` builds browser assets and compile-checks both entrypoints.
- \`npm start\` runs the production server.
- \`npm run voyd:check\` compile-checks the server and browser modules.
- \`npm run typecheck\` checks the TypeScript bridge.

Set \`HOST\`/\`VOYD_WEB_HOST\` and \`PORT\`/\`VOYD_WEB_PORT\` to configure the listener.
`;
