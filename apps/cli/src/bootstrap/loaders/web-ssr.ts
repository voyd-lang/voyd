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
              "@voyd-lang/web": `^${voydVersion}`,
            },
            devDependencies: {
              "@tailwindcss/vite": "^4.3.0",
              "@types/node": "^22.5.1",
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

export default defineConfig({
  plugins: [tailwindcss()],
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

  const close = async () => {
    await app.close("shutdown").catch(() => undefined);
    process.exit(0);
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  await app.closed.catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
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

const clientTs = `import "./style.css";

const root = document.querySelector<HTMLElement>("[data-article-slug]");
const editor = document.querySelector<HTMLTextAreaElement>("[data-article-body]");
const jumpForm = document.querySelector<HTMLFormElement>("[data-jump-form]");
const saveButton = document.querySelector<HTMLButtonElement>("[data-save-article]");
const status = document.querySelector<HTMLElement>("[data-save-status]");

if (jumpForm) {
  jumpForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = new FormData(jumpForm);
    const slug = String(form.get("slug") ?? "").trim().toLowerCase();
    if (!slug) return;
    window.location.assign(\`/wiki/\${encodeURIComponent(slug)}\`);
  });
}

if (root && editor && saveButton && status) {
  let clean = editor.value;
  editor.addEventListener("input", () => {
    status.textContent = editor.value === clean ? "Saved" : "Unsaved changes";
  });

  saveButton.addEventListener("click", async () => {
    const slug = root.dataset.articleSlug ?? "home";
    saveButton.disabled = true;
    status.textContent = "Saving...";

    try {
      const response = await fetch(\`/api/articles?slug=\${encodeURIComponent(slug)}\`, {
        method: "POST",
        headers: { "content-type": "text/plain; charset=utf-8" },
        body: editor.value,
      });

      if (!response.ok) {
        throw new Error(await response.text());
      }

      clean = editor.value;
      status.textContent = "Saved";
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : "Save failed";
    } finally {
      saveButton.disabled = false;
    }
  });
}
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
  body: String
}

pub fn main(): (server::HttpServer, tasks::TaskRuntime, env::Env, fs::Fs) -> i32
  let port = app_port()
  let host = app_host()
  let result = serve(
    port: port,
    host: host,
    shutdown_timeout: 30000,
    max_body_bytes: 65536
  ) routes():
    adopt(serve_dir("./public".as_slice()))

    get("/") do:
      article_page(load_article("home".as_slice().to_string()))

    get("/wiki/:slug") do(params: ArticleParams):
      article_page(load_article(safe_slug(params.slug)))

    post("/api/articles", body: text_body()) do(input: String, ctx: Context):
      save_article(input, ctx)

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
        body: value
      }
    Err<IoError>:
      {
        slug: clean,
        title: title_for(clean),
        body: "# New article\\n\\nStart writing. Click Save to create the local file.".as_slice().to_string()
      }

fn save_article(input: String, ctx: Context): fs::Fs -> Response
  let slug = safe_slug(ctx.query_value("slug".as_slice()) ?? "home".as_slice().to_string())
  match(write_file_string(article_path(slug), input))
    Ok<Unit>:
      Response::ok().text("saved".as_slice())
    Err<IoError> { error }:
      Response::internal_server_error().text(error.message)

fn article_path(slug: String) -> Path
  Path::new("./data/articles".as_slice()).join(slug.concat(".md".as_slice()))

fn safe_slug(value: String) -> String
  let trimmed = value.as_slice().trimmed().to_string()
  if trimmed.is_empty():
    return "home".as_slice().to_string()
  if trimmed.contains("/".as_slice()) or trimmed.contains("..".as_slice()):
    return "home".as_slice().to_string()
  trimmed.lowered()

fn title_for(slug: String) -> String
  if slug.equals("home"):
    "Mini Voydpedia".as_slice().to_string()
  else:
    slug

fn article_page(article: Article) -> Response
  Response::ok()
    .with(header: "content-type".as_slice(), value: "text/html; charset=utf-8".as_slice())
    .text(document<MsgPack>(page_view(article)))

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
          <form class="mt-8 flex gap-2" action="/wiki/home" method="get" data-jump-form="true">
            <input
              class="min-w-0 flex-1 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-emerald-600"
              name="slug"
              placeholder="article-slug"
            ></input>
            <button class="rounded-md bg-zinc-950 px-3 py-2 text-sm font-medium text-white" type="submit">Open</button>
          </form>
        </aside>
        <section class="mx-auto flex w-full max-w-5xl flex-col px-5 py-8 lg:px-10">
          <header class="flex flex-col gap-4 border-b border-zinc-200 pb-6 md:flex-row md:items-end md:justify-between">
            <div>
              <p class="text-sm font-medium uppercase tracking-wide text-emerald-700">Local file article</p>
              <h1 class="mt-2 text-4xl font-semibold tracking-tight text-zinc-950">{article.title}</h1>
              <p class="mt-3 max-w-2xl text-zinc-600">
                Server-rendered by Voyd. Saved as <code class="rounded bg-zinc-100 px-1.5 py-0.5 text-zinc-800">data/articles/{article.slug}.md</code>.
              </p>
            </div>
            <div class="flex items-center gap-3">
              <span class="text-sm text-zinc-500" data-save-status="true">Saved</span>
              <button
                class="rounded-md bg-emerald-700 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-800 disabled:cursor-wait disabled:bg-zinc-400"
                type="button"
                data-save-article="true"
              >
                Save
              </button>
            </div>
          </header>
          <label class="mt-8 flex min-h-[32rem] flex-1 flex-col">
            <span class="mb-3 text-sm font-medium text-zinc-700">Article body</span>
            <textarea
              class="min-h-[32rem] flex-1 resize-y rounded-md border border-zinc-300 bg-white p-5 font-mono text-sm leading-7 text-zinc-900 outline-none shadow-sm focus:border-emerald-600 focus:ring-2 focus:ring-emerald-100"
              spellcheck="true"
              data-article-body="true"
            >{article.body}</textarea>
          </label>
        </section>
      </main>
      <script type="module" src="/assets/client.js"></script>
    </body>
  </html>

fn NavLink({ href: String, label: String, active: bool }) -> Html<MsgPack>
  <a class={nav_class(active)} href={href}>
    {label}
  </a>

fn nav_class(active: bool) -> String
  if active:
    "rounded-md bg-emerald-50 px-3 py-2 font-medium text-emerald-800".as_slice().to_string()
  else:
    "rounded-md px-3 py-2 text-zinc-600 hover:bg-zinc-100 hover:text-zinc-950".as_slice().to_string()
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
dist
.turbo
.DS_Store
data/articles/*.md
!data/articles/home.md
!data/articles/voyd.md
!data/articles/webassembly.md
`;

const readme = (packageName: string) => `# ${packageName}

Mini Voydpedia is a server-rendered Voyd app with Tailwind assets built by Vite.
Articles are local markdown files in \`data/articles\`, so edits are easy to
diff, seed, back up, or delete.

## Scripts

- \`npm run dev\` builds the client assets, starts the Voyd SSR server, rebuilds
  assets when \`src/**/*.ts\` or \`src/**/*.css\` changes, and restarts the server
  when \`src/**/*.voyd\` changes.
- \`npm run build\` builds the Tailwind/client assets into \`public/assets\` and
  checks the Voyd server with optimized compilation.
- \`npm start\` runs the production-style SSR server.
- \`npm run voyd:check\` compiles only the Voyd server.
- \`npm run typecheck\` checks the TypeScript helper scripts and client code.

## Configuration

- \`PORT\` or \`VOYD_WEB_PORT\` changes the server port. The default is \`3000\`.
- \`HOST\` or \`VOYD_WEB_HOST\` changes the bind host. The default is
  \`127.0.0.1\`.

The article save endpoint accepts request bodies up to 64 KiB by default. Adjust
\`max_body_bytes\` in \`src/main.voyd\` if your app needs larger edits.
`;
