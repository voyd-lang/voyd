import type { BootstrapLoader, BootstrapPlan } from "../types.js";

export const webSsrLoader: BootstrapLoader = {
  id: "web-ssr",
  description: "SSR web app with Tailwind",
  plan: ({ packageName, voydVersion }): BootstrapPlan => ({
    template: "web-ssr",
    files: [
      {
        path: "package.json",
        content: `${JSON.stringify(
          {
            name: packageName,
            private: true,
            type: "module",
            scripts: {
              dev: "node scripts/dev.mjs",
              build: "vite build && node scripts/check-voyd.mjs",
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
              module: "ESNext",
              lib: ["ES2022", "DOM", "DOM.Iterable"],
              types: ["node", "vite/client"],
              skipLibCheck: true,
              moduleResolution: "bundler",
              allowImportingTsExtensions: true,
              isolatedModules: true,
              moduleDetection: "force",
              noEmit: true,
              strict: true,
            },
            include: ["scripts", "src"],
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
        path: "README.md",
        content: readme(packageName),
      },
      {
        path: "scripts/check-voyd.mjs",
        content: checkVoydScript,
      },
      {
        path: "scripts/compile-client-voyd.mjs",
        content: compileClientVoydScript,
      },
      {
        path: "scripts/dev.mjs",
        content: devScript,
      },
      {
        path: "scripts/serve.mjs",
        content: serveScript,
      },
      {
        path: "src/client.ts",
        content: clientTs,
      },
      {
        path: "src/client.voyd",
        content: clientVoyd,
      },
      {
        path: "src/main.voyd",
        content: mainVoyd,
      },
      {
        path: "src/style.css",
        content: styleCss,
      },
      {
        path: "data/articles/home.md",
        content: homeArticle,
      },
      {
        path: "data/articles/voyd.md",
        content: voydArticle,
      },
      {
        path: "data/articles/webassembly.md",
        content: webassemblyArticle,
      },
      {
        path: "public/.gitkeep",
        content: "",
      },
    ],
    nextSteps: ["npm install", "npm run dev"],
  }),
};

const viteConfig = `import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { compileClientVoyd } from "./scripts/compile-client-voyd.mjs";

const voydClient = () => ({
  name: "voyd-client",
  async buildStart() {
    await compileClientVoyd();
  },
  configureServer(server) {
    server.watcher.add("src/client.voyd");
  },
  async handleHotUpdate(ctx) {
    if (!ctx.file.endsWith("client.voyd")) return;

    await compileClientVoyd();
    ctx.server.ws.send({ type: "full-reload" });
    return [];
  },
});

export default defineConfig({
  plugins: [voydClient(), tailwindcss()],
  publicDir: false,
  build: {
    outDir: "public",
    emptyOutDir: false,
    manifest: false,
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

const checkVoydScript = `import { createSdk } from "@voyd-lang/sdk";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compileClientVoyd } from "./compile-client-voyd.mjs";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const entryPath = resolve(rootDir, "src/main.voyd");
const sdk = createSdk();
const result = await sdk.compile({
  entryPath,
  optimize: true,
  runtimeDiagnostics: true,
});

if (!result.success) {
  console.error(formatDiagnostics(result.diagnostics));
  process.exit(1);
}

await compileClientVoyd();
console.log("Voyd server compiled successfully.");

function formatDiagnostics(diagnostics) {
  return diagnostics
    .map((diagnostic) => {
      const location = diagnostic.location
        ? \`\${diagnostic.location.filePath}:\${diagnostic.location.start.line}:\${diagnostic.location.start.column}\`
        : diagnostic.file ?? "voyd";
      return \`\${location} \${diagnostic.severity}: \${diagnostic.message}\`;
    })
    .join("\\n");
}
`;

const compileClientVoydScript = `import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const entryPath = resolve(rootDir, "src/client.voyd");
const outPath = resolve(rootDir, "src/generated/client.wasm");

export async function compileClientVoyd({ verbose = true } = {}) {
  await mkdir(dirname(outPath), { recursive: true });
  const wasm = await runVoyd(["--emit-wasm", "--opt", entryPath]);
  await writeFile(outPath, wasm);
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
  await compileClientVoyd();
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
  const sdk = createSdk();
  const result = await sdk.serveWebApp({
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
    throw new Error(formatDiagnostics(result.diagnostics));
  }

  return result;
}

function readPort() {
  const raw = process.env.PORT ?? process.env.VOYD_WEB_PORT ?? "3000";
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : 3000;
}

function formatDiagnostics(diagnostics) {
  return diagnostics
    .map((diagnostic) => {
      const location = diagnostic.location
        ? \`\${diagnostic.location.filePath}:\${diagnostic.location.start.line}:\${diagnostic.location.start.column}\`
        : diagnostic.file ?? "voyd";
      return \`\${location} \${diagnostic.severity}: \${diagnostic.message}\`;
    })
    .join("\\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let app;
  try {
    app = await serve();
    console.log(\`Voyd wiki ready at \${app.url}\`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }

  let closing = false;
  const keepAlive = setInterval(() => undefined, 1_000_000_000);
  app.closed.catch((error) => {
    if (closing) return;
    clearInterval(keepAlive);
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });

  await waitForShutdown(async (signal) => {
    closing = true;
    clearInterval(keepAlive);
    await app.close(signal).catch(() => undefined);
  });
}

function waitForShutdown(close) {
  return new Promise((resolve) => {
    let closing = false;
    const shutdown = (signal) => {
      if (closing) return;
      closing = true;
      void close(signal).finally(resolve);
    };
    process.once("SIGINT", () => shutdown("SIGINT"));
    process.once("SIGTERM", () => shutdown("SIGTERM"));
  });
}
`;

const devScript = `import { spawn } from "node:child_process";
import { readdirSync, statSync, watch } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "./serve.mjs";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const sourceDir = resolve(rootDir, "src");
const port = Number.parseInt(process.env.PORT ?? process.env.VOYD_WEB_PORT ?? "3000", 10);

let app;
let building = false;
let restarting = false;
let buildQueued = false;
let restartQueued = false;

await buildClient();
await restartServer();

const watcher = watchSource();

function queueBuild() {
  buildQueued = true;
  if (building) return;
  setTimeout(() => void buildClient(), 75);
}

function queueRestart() {
  restartQueued = true;
  if (restarting) return;
  setTimeout(() => void restartServer(), 75);
}

async function buildClient() {
  if (building) return;
  buildQueued = false;
  building = true;
  try {
    await run("vite", ["build", "--mode", "development"]);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
  } finally {
    building = false;
    if (buildQueued) {
      setTimeout(() => void buildClient(), 75);
    }
  }
}

async function restartServer() {
  if (restarting) return;
  if (!restartQueued && app) return;
  restartQueued = false;
  restarting = true;
  try {
    if (app) {
      await app.close("restart").catch(() => undefined);
    }
    app = await serve({
      port: Number.isFinite(port) ? port : 3000,
      optimize: process.env.NODE_ENV === "production",
    });
    console.log(\`Voyd wiki ready at \${app.url}\`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
  } finally {
    restarting = false;
    if (restartQueued) {
      setTimeout(() => void restartServer(), 75);
    }
  }
}

async function shutdown() {
  watcher?.close();
  if (app) {
    await app.close("shutdown").catch(() => undefined);
  }
  process.exit(0);
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

function run(name, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command(name), args, {
      cwd: rootDir,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(\`\${name} \${args.join(" ")} exited with code \${code}\`));
    });
  });
}

function watchSource() {
  const watchers = new Map();

  const watchTree = (dir) => {
    watchDir(dir);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        watchTree(join(dir, entry.name));
      }
    }
  };

  const watchDir = (dir) => {
    if (watchers.has(dir)) return;
    const sourceWatcher = watch(dir, { persistent: true }, (_event, filename) => {
      if (!filename) {
        queueBuild();
        queueRestart();
        return;
      }

      const filePath = join(dir, filename.toString());
      if (isDirectory(filePath)) {
        watchTree(filePath);
        return;
      }
      handleSourceChange(filePath);
    });
    sourceWatcher.on("error", (error) => {
      console.error(\`Source file watching stopped: \${error instanceof Error ? error.message : error}\`);
    });
    watchers.set(dir, sourceWatcher);
  };

  try {
    watchTree(sourceDir);
  } catch (error) {
    console.error(\`Source file watching unavailable: \${error instanceof Error ? error.message : error}\`);
    return undefined;
  }
  return {
    close() {
      for (const sourceWatcher of watchers.values()) {
        sourceWatcher.close();
      }
      watchers.clear();
    },
  };
}

function handleSourceChange(filePath) {
  if (filePath.endsWith("client.voyd")) {
    queueBuild();
    return;
  }
  if (filePath.endsWith(".voyd")) {
    queueBuild();
    queueRestart();
    return;
  }
  if (filePath.endsWith(".css") || filePath.endsWith(".ts")) {
    queueBuild();
  }
}

function isDirectory(filePath) {
  try {
    return statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

function command(name) {
  return process.platform === "win32" ? \`\${name}.cmd\` : name;
}
`;

const clientTs = `import { createVoydHost } from "@voyd-lang/sdk/js-host";
import { createVoydVxAppRuntime, hydrateVxApp } from "@voyd-lang/vx-dom/browser";
import wasmUrl from "./generated/client.wasm?url";
import "./style.css";

const hydration = document.querySelector<HTMLScriptElement>("[data-voyd-hydration]");
const targetSelector = hydration?.dataset.voydHydration;
const target = targetSelector ? document.querySelector(targetSelector) : undefined;

if (!hydration || !target) {
  throw new Error("Mini Voydpedia hydration target was not found.");
}

const initialModel = JSON.parse(hydration.textContent ?? "null");

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
`;

const mainVoyd = `use pkg::web::all
use std::env::self as env
use std::error::{ HostError, IoError }
use std::fs::self as fs
use std::fs::{ read_string as read_file_string, write_string as write_file_string }
use std::http::server
use std::msgpack::MsgPack
use std::optional::types::all
use std::path::Path
use std::result::types::all
use std::string::type::String
use std::task::self as tasks
use std::vx::all

type ArticleParams = {
  slug: String
}

type Article = {
  slug: String,
  title: String,
  body: String,
  status: String
}

obj ClientArticle {
  slug: String,
  title: String,
  body: String,
  saved_body: String,
  status: String,
  preview_open: bool,
  save_count: i32
}

pub fn main(): (server::HttpServer, tasks::TaskRuntime, env::Env, fs::Fs) -> i32
  let port = app_port()
  let host = app_host()
  let web_app = app()
    .adopt(serve_dir("./public".as_slice()))
    .get_unit("/".as_slice(), handler: () -> Response =>
      article_page(load_article("home".as_slice().to_string()))
    )
    .get_context("/wiki".as_slice(), handler: (ctx: Context) -> Response =>
      article_page(load_article(article_slug_from(ctx)))
    )
    .get_context("/wiki/:slug".as_slice(), handler: (ctx: Context) -> Response =>
      article_page(load_article(article_slug_from(ctx)))
    )
    .post_context("/wiki/:slug/body".as_slice(), handler: (ctx: Context) -> Response =>
      save_article_body(request_text_body(ctx), article_slug_from(ctx))
    )
    .post_context("/wiki/:slug".as_slice(), handler: (ctx: Context) -> Response =>
      save_article(form_article_body(request_text_body(ctx)), article_slug_from(ctx))
    )

  let result = server::serve_each(
    config: server::ServerConfig::init(
      port: port,
      host: host,
      max_body_bytes: 65536,
      response_timeout_millis: 30000
    ),
    policy: server::ServeTaskPolicy::sequential(),
    handle: (request: IncomingRequest) -> Response => web_app.handle(request)
  )

  match(result)
    Ok<Unit>:
      0
    Err<HostError> { error }:
      -error.code

fn app_port(): env::Env -> i32
  match(env::get_int("VOYD_WEB_PORT".as_slice()))
    Some<i32> { value }:
      value
    None:
      3000

fn app_host(): env::Env -> String
  match(env::get("VOYD_WEB_HOST".as_slice()))
    Some<String> { value }:
      value
    None:
      "127.0.0.1".as_slice().to_string()

fn load_article(slug: String): fs::Fs -> Article
  let clean = safe_slug(slug)
  match(read_file_string(article_path(clean)))
    Ok<String> { value }:
      {
        slug: clean,
        title: title_for(clean),
        body: value,
        status: "Saved".as_slice().to_string()
      }
    Err<IoError>:
      {
        slug: clean,
        title: title_for(clean),
        body: "# New article\\n\\nStart writing. Click Save to create the local file.".as_slice().to_string(),
        status: "Draft".as_slice().to_string()
      }

fn article_slug_from(ctx: Context) -> String
  safe_slug(ctx.param("slug".as_slice()) ?? ctx.query_value("slug".as_slice()) ?? "home".as_slice().to_string())

fn request_text_body(ctx: Context) -> String
  match(ctx.request.body.as_text())
    Ok<String> { value }:
      value
    Err:
      String::init()

fn save_article(body: String, slug: String): fs::Fs -> Response
  match(write_file_string(article_path(slug), body))
    Ok<Unit>:
      article_page({
        slug: slug,
        title: title_for(slug),
        body: body,
        status: "Saved".as_slice().to_string()
      })
    Err<IoError> { error }:
      Response::internal_server_error().text(error.message)

fn save_article_body(body: String, slug: String): fs::Fs -> Response
  match(write_file_string(article_path(slug), body))
    Ok<Unit>:
      Response::ok()
        .with(header: "content-type".as_slice(), value: "text/plain; charset=utf-8".as_slice())
        .text("saved".as_slice())
    Err<IoError> { error }:
      Response::internal_server_error().text(error.message)

fn form_article_body(input: String) -> String
  parse_query(input).get("body".as_slice()) ?? String::init()

fn article_path(slug: String) -> Path
  Path::new("./data/articles".as_slice()).join(slug.concat(".md".as_slice()))

fn safe_slug(value: String) -> String
  let lower = value.as_slice().trimmed().to_string().lowered()
  if lower.is_empty():
    return "home".as_slice().to_string()
  if lower.contains(where: (rune: i32) -> bool => not is_slug_rune(rune)):
    return "home".as_slice().to_string()
  lower

fn is_slug_rune(rune: i32) -> bool
  (rune >= 97 and rune <= 122) or (rune >= 48 and rune <= 57) or rune == 45 or rune == 95

fn title_for(slug: String) -> String
  if slug.equals("home"):
    "Mini Voydpedia".as_slice().to_string()
  else:
    slug

fn article_page(article: Article) -> Response
  Response::ok()
    .with(header: "content-type".as_slice(), value: "text/html; charset=utf-8".as_slice())
    .text(document<MsgPack, ClientArticle>(
      view: page_view(article),
      hydrate: hydrate<ClientArticle>(
        target: "#article-app".as_slice(),
        entry: "/assets/client.js".as_slice(),
        model: client_article(article)
      )
    ))

fn client_article(article: Article) -> ClientArticle
  ClientArticle {
    slug: article.slug,
    title: article.title,
    body: article.body,
    saved_body: article.body,
    status: article.status,
    preview_open: true,
    save_count: 0
  }

fn page_view(article: Article) -> Html<MsgPack>
  <html lang="en">
    <head>
      <meta charset="utf-8"></meta>
      <meta name="viewport" content="width=device-width, initial-scale=1"></meta>
      <title>{article.title}</title>
      <link rel="stylesheet" href="/assets/client.css"></link>
    </head>
    <body class="min-h-screen bg-stone-50 text-zinc-950 antialiased">
      <main
        class="grid min-h-screen grid-cols-1 lg:grid-cols-[18rem_minmax(0,1fr)]"
        data-article-slug={article.slug}
      >
        <aside class="border-b border-zinc-200 bg-white px-5 py-6 lg:border-b-0 lg:border-r">
          <a class="block text-lg font-semibold tracking-tight text-emerald-700" href="/">Mini Voydpedia</a>
          <nav class="mt-8 grid gap-2 text-sm">
            <NavLink href="/" label="Home" active={article.slug.equals("home")} />
            <NavLink href="/wiki/voyd" label="Voyd" active={article.slug.equals("voyd")} />
            <NavLink href="/wiki/webassembly" label="WebAssembly" active={article.slug.equals("webassembly")} />
          </nav>
          <form class="mt-8 flex gap-2" action="/wiki" method="get">
            <input
              class="min-w-0 flex-1 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-emerald-600"
              name="slug"
              placeholder="article-slug"
            ></input>
            <button class="rounded-md bg-zinc-950 px-3 py-2 text-sm font-medium text-white" type="submit">Open</button>
          </form>
        </aside>
        <div id="article-app">
          <ArticleEditor article={article} />
        </div>
      </main>
    </body>
  </html>

fn ArticleEditor({ article: Article }) -> Html<MsgPack>
  <form class="mx-auto flex w-full max-w-5xl flex-col px-5 py-8 lg:px-10" action={article_form_action(article.slug)} method="post">
    <header class="flex flex-col gap-4 border-b border-zinc-200 pb-6 md:flex-row md:items-end md:justify-between">
      <div>
        <p class="text-sm font-medium uppercase tracking-wide text-emerald-700">Local file article</p>
        <h1 class="mt-2 text-4xl font-semibold tracking-tight text-zinc-950">{article.title}</h1>
        <p class="mt-3 max-w-2xl text-zinc-600">
          Server-rendered by Voyd and hydrated by a Voyd client module. Saved as <code class="rounded bg-zinc-100 px-1.5 py-0.5 text-zinc-800">data/articles/{article.slug}.md</code>.
        </p>
      </div>
      <div class="flex flex-wrap items-center gap-3">
        <span class="rounded-full bg-emerald-100 px-3 py-1 text-sm font-medium text-emerald-800">{article.status}</span>
        <button
          class="rounded-md bg-emerald-700 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-800"
          type="submit"
        >
          Save
        </button>
      </div>
    </header>
    <label class="mt-8 flex min-h-[32rem] flex-1 flex-col">
      <span class="mb-3 text-sm font-medium text-zinc-700">Article body</span>
      <textarea
        class="min-h-[32rem] flex-1 resize-y rounded-md border border-zinc-300 bg-white p-5 font-mono text-sm leading-7 text-zinc-900 outline-none shadow-sm focus:border-emerald-600 focus:ring-2 focus:ring-emerald-100"
        name="body"
        spellcheck="true"
      >{article.body}</textarea>
    </label>
  </form>

fn NavLink({ href: String, label: String, active: bool }) -> Html<MsgPack>
  <a class={nav_class(active)} href={href}>
    {label}
  </a>

fn nav_class(active: bool) -> String
  if active:
    "rounded-md bg-emerald-50 px-3 py-2 font-medium text-emerald-800".as_slice().to_string()
  else:
    "rounded-md px-3 py-2 text-zinc-600 hover:bg-zinc-100 hover:text-zinc-950".as_slice().to_string()

fn article_form_action(slug: String) -> String
  "/wiki/".as_slice().to_string().concat(slug)
`;

const clientVoyd = `use std::array::Array
use std::enums::{ enum }
use std::error::HostError
use std::http::{ Body, Response }
use std::http::client::self as http_client
use std::msgpack::MsgPack
use std::number::cast::to_string
use std::result::types::all
use std::string::type::String
use std::vx::all

obj SaveResult {
  ok: bool,
  body: String,
  message: String
}

obj ClientArticle {
  slug: String,
  title: String,
  body: String,
  saved_body: String,
  status: String,
  preview_open: bool,
  save_count: i32
}

enum Msg
  Edit { value: String }
  Save
  Reset
  TogglePreview

pub fn app() -> Program<ClientArticle, Msg>
  program<ClientArticle, Msg>(
    init: init,
    update: update,
    view: view
  )

fn init() -> ClientArticle
  ClientArticle {
    slug: "home",
    title: "Mini Voydpedia",
    body: String::init(),
    saved_body: String::init(),
    status: "Saved",
    preview_open: true,
    save_count: 0
  }

fn update(model: ClientArticle, message: Msg): http_client::HttpClient -> Program<ClientArticle, Msg>
  match(message)
    Msg::Edit { value }:
      next(ClientArticle {
        slug: model.slug,
        title: model.title,
        body: value,
        saved_body: model.saved_body,
        status: dirty_status(value, model.saved_body),
        preview_open: model.preview_open,
        save_count: model.save_count
      })
    Msg::Reset:
      next(ClientArticle {
        slug: model.slug,
        title: model.title,
        body: model.saved_body,
        saved_body: model.saved_body,
        status: "Restored saved article",
        preview_open: model.preview_open,
        save_count: model.save_count
      })
    Msg::TogglePreview:
      next(ClientArticle {
        slug: model.slug,
        title: model.title,
        body: model.body,
        saved_body: model.saved_body,
        status: model.status,
        preview_open: not model.preview_open,
        save_count: model.save_count
      })
    Msg::Save:
      let result = save_article(model.slug, model.body)
      if result.ok:
        return next(ClientArticle {
          slug: model.slug,
          title: model.title,
          body: result.body,
          saved_body: result.body,
          status: result.message,
          preview_open: model.preview_open,
          save_count: model.save_count + 1
        })
      next(ClientArticle {
        slug: model.slug,
        title: model.title,
        body: model.body,
        saved_body: model.saved_body,
        status: result.message,
        preview_open: model.preview_open,
        save_count: model.save_count
      })

fn view(model: ClientArticle) -> Html<Msg>
  <form
    class="mx-auto flex w-full max-w-5xl flex-col px-5 py-8 lg:px-10"
    action={article_form_action(model.slug)}
    method="post"
  >
    <header class="flex flex-col gap-4 border-b border-zinc-200 pb-6 md:flex-row md:items-end md:justify-between">
      <div>
        <p class="text-sm font-medium uppercase tracking-wide text-emerald-700">Local file article</p>
        <h1 class="mt-2 text-4xl font-semibold tracking-tight text-zinc-950">{model.title}</h1>
        <p class="mt-3 max-w-2xl text-zinc-600">
          Server-rendered by Voyd and hydrated by a Voyd client module. Saved as <code class="rounded bg-zinc-100 px-1.5 py-0.5 text-zinc-800">data/articles/{model.slug}.md</code>.
        </p>
      </div>
      <div class="flex flex-wrap items-center gap-3">
        <span class={status_class(model)}>{model.status}</span>
        <button
          class="rounded-md border border-zinc-300 bg-white px-4 py-2 text-sm font-semibold text-zinc-800 shadow-sm transition hover:bg-zinc-50 disabled:cursor-not-allowed disabled:text-zinc-400"
          type="button"
          disabled={not is_dirty(model)}
          on_click={Msg::Reset {}}
        >
          Reset
        </button>
        <button
          class="rounded-md border border-emerald-700 bg-white px-4 py-2 text-sm font-semibold text-emerald-800 shadow-sm transition hover:bg-emerald-50"
          type="button"
          on_click={Msg::TogglePreview {}}
        >
          {preview_button_label(model)}
        </button>
        <button
          class="rounded-md bg-emerald-700 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-800 disabled:cursor-not-allowed disabled:bg-zinc-400"
          type="button"
          disabled={not is_dirty(model)}
          on_click={Msg::Save {}}
        >
          Save
        </button>
      </div>
    </header>
    <section class="grid gap-4 border-b border-zinc-200 py-4 text-sm text-zinc-600 sm:grid-cols-4">
      <Stat label="Words" value={to_string(word_count(model.body))} />
      <Stat label="Characters" value={to_string(model.body.byte_len())} />
      <Stat label="Local state" value={dirty_label(model)} />
      <Stat label="Client saves" value={to_string(model.save_count)} />
    </section>
    <div class={editor_grid_class(model)}>
      <label class="mt-8 flex min-h-[32rem] flex-1 flex-col">
        <span class="mb-3 text-sm font-medium text-zinc-700">Article body</span>
        <textarea
          class="min-h-[32rem] flex-1 resize-y rounded-md border border-zinc-300 bg-white p-5 font-mono text-sm leading-7 text-zinc-900 outline-none shadow-sm focus:border-emerald-600 focus:ring-2 focus:ring-emerald-100"
          name="body"
          spellcheck="true"
          value={model.body}
          on_input={(event: InputEvent) -> Msg => Msg::Edit { value: event.value }}
        >{model.body}</textarea>
      </label>
      <Preview model={model} />
    </div>
  </form>

fn Preview({ model: ClientArticle }) -> Html<Msg>
  if model.preview_open:
    <aside class="mt-8 rounded-md border border-zinc-200 bg-white p-5 shadow-sm">
      <div class="flex items-center justify-between border-b border-zinc-200 pb-3">
        <h2 class="text-sm font-semibold uppercase tracking-wide text-zinc-500">Live preview</h2>
        <span class="text-xs font-medium text-emerald-700">Voyd client state</span>
      </div>
      <article class="prose mt-5 max-w-none text-zinc-800">
        <h3 class="text-2xl font-semibold text-zinc-950">{model.title}</h3>
        <pre class="whitespace-pre-wrap rounded-md bg-zinc-50 p-4 text-sm leading-7 text-zinc-800">{model.body}</pre>
      </article>
    </aside>
  else:
    fragment(Array<MsgPack>::init())

fn Stat({ label: String, value: String }) -> Html<Msg>
  <div class="rounded-md border border-zinc-200 bg-white px-3 py-2">
    <div class="text-xs font-medium uppercase tracking-wide text-zinc-500">{label}</div>
    <div class="mt-1 font-semibold text-zinc-950">{value}</div>
  </div>

fn next(model: ClientArticle) -> Program<ClientArticle, Msg>
  program<ClientArticle, Msg>(model: model)

fn save_article(slug: String, body: String): http_client::HttpClient -> SaveResult
  let result: Result<Response, HostError> = http_client::post(url: article_body_action(slug), body: Body::text(body))
  match(result)
    Ok<Response> { value }:
      if value.is_success():
        SaveResult {
          ok: true,
          body: body,
          message: "Saved from Voyd client"
        }
      else:
        SaveResult {
          ok: false,
          body: body,
          message: "Save failed"
        }
    Err<HostError> { error }:
      SaveResult {
        ok: false,
        body: body,
        message: error.message
      }

fn article_form_action(slug: String) -> String
  "/wiki/".as_slice().to_string().concat(slug)

fn article_body_action(slug: String) -> String
  article_form_action(slug).concat("/body".as_slice())

fn is_dirty(model: ClientArticle) -> bool
  not (model.body == model.saved_body)

fn dirty_status(body: String, saved_body: String) -> String
  if body == saved_body:
    "Saved"
  else:
    "Unsaved changes"

fn dirty_label(model: ClientArticle) -> String
  if is_dirty(model):
    "Unsaved"
  else:
    "Saved"

fn status_class(model: ClientArticle) -> String
  if is_dirty(model):
    "rounded-full bg-amber-100 px-3 py-1 text-sm font-medium text-amber-800"
  else:
    "rounded-full bg-emerald-100 px-3 py-1 text-sm font-medium text-emerald-800"

fn preview_button_label(model: ClientArticle) -> String
  if model.preview_open:
    "Hide preview"
  else:
    "Show preview"

fn editor_grid_class(model: ClientArticle) -> String
  if model.preview_open:
    "grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]"
  else:
    "grid gap-6"

fn word_count(value: String) -> i32
  var count = 0
  var in_word = false
  var index = 0
  while index < value.byte_len():
    match(value.get_byte(index))
      Some<i32> { value: byte }:
        if is_space(byte):
          in_word = false
        else:
          if not in_word:
            count = count + 1
            in_word = true
      None:
        void
    index = index + 1
  count

fn is_space(byte: i32) -> bool
  byte == 9 or byte == 10 or byte == 13 or byte == 32
`;

const styleCss = `@import "tailwindcss";

@source "./**/*.voyd";

:root {
  font-family:
    Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI",
    sans-serif;
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

This tiny wiki is rendered on the server by Voyd and styled with Tailwind.

Edit this article, click Save, and inspect data/articles/home.md. The page is
just a local file, so it is easy to seed, diff, back up, or delete.
`;

const voydArticle = `# Voyd

Voyd is a programming language that compiles to WebAssembly. This app uses the
Voyd web framework to route HTTP requests, render HTML, and write articles
through std::fs.
`;

const webassemblyArticle = `# WebAssembly

WebAssembly is the portable compilation target that runs this server. The
JavaScript host starts the Voyd module and provides filesystem and HTTP server
capabilities.
`;

const gitIgnore = `node_modules
public/assets
src/generated
dist
.turbo
.DS_Store
data/articles/*.md
!data/articles/home.md
!data/articles/voyd.md
!data/articles/webassembly.md
`;

const readme = (packageName: string) => `# ${packageName}

Mini Voydpedia is a server-rendered Voyd app with a hydrated Voyd client module
and Tailwind assets built by Vite. Articles are local markdown files in
\`data/articles\`, so edits are easy to diff, seed, back up, or delete.

The browser TypeScript entrypoint only loads the compiled Voyd client wasm and
hydrates the server-rendered form. Routing, article lookup, rendering, client
editor state, client save behavior, and filesystem writes all live in Voyd:
\`src/main.voyd\` for the server and \`src/client.voyd\` for the browser.

## Scripts

- \`npm run dev\` builds the client assets, starts the Voyd SSR server, rebuilds
  assets when \`src/client.voyd\`, \`src/**/*.ts\`, or \`src/**/*.css\` changes,
  and restarts the server when other \`src/**/*.voyd\` files change.
- \`npm run build\` builds the Tailwind/client assets into \`public/assets\` and
  checks the Voyd server and client with optimized compilation.
- \`npm start\` runs the production-style SSR server.
- \`npm run voyd:check\` compiles the Voyd server and browser module.
- \`npm run typecheck\` checks the TypeScript helper scripts and wasm hydration
  entrypoint.

## Configuration

- \`PORT\` or \`VOYD_WEB_PORT\` changes the server port. The default is \`3000\`.
- \`HOST\` or \`VOYD_WEB_HOST\` changes the bind host. The default is
  \`127.0.0.1\`.

Article form posts accept request bodies up to 64 KiB by default. Adjust
\`max_body_bytes\` in \`src/main.voyd\` if your app needs larger edits.
`;
