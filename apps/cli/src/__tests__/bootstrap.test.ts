// @vitest-environment happy-dom

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createSdk, type CompileResult } from "@voyd-lang/sdk";
import { createVoydHost } from "@voyd-lang/sdk/js-host";
import { createVxDomRenderer } from "@voyd-lang/vx-dom";
import {
  detectLocalVoydRoot,
  printBootstrapResult,
  runBootstrap,
} from "../bootstrap/index.js";

const createTempDir = () => mkdtemp(resolve(tmpdir(), "voyd-bootstrap-"));
const repoRoot = resolve(import.meta.dirname, "../../../..");

const expectCompileSuccess = (
  result: CompileResult,
): Extract<CompileResult, { success: true }> => {
  if (!result.success) {
    throw new Error(
      result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"),
    );
  }
  return result;
};

describe("runBootstrap", () => {
  it("detects a local checkout by root package name and otherwise falls back", async () => {
    const root = await createTempDir();
    const moduleUrl = pathToFileURL(
      resolve(root, "apps/cli/dist/bootstrap/index.js"),
    ).href;
    const packagePath = resolve(root, "package.json");
    try {
      await writeFile(packagePath, JSON.stringify({ name: "voyd-monorepo" }));
      expect(detectLocalVoydRoot(moduleUrl)).toBe(root);

      await writeFile(packagePath, JSON.stringify({ name: "some-other-project" }));
      expect(detectLocalVoydRoot(moduleUrl)).toBeUndefined();

      await writeFile(packagePath, "not json");
      expect(detectLocalVoydRoot(moduleUrl)).toBeUndefined();

      await rm(packagePath);
      expect(detectLocalVoydRoot(moduleUrl)).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("scaffolds the vx-spa starter", async () => {
    const root = await createTempDir();
    const target = resolve(root, "my app");
    try {
      const result = await runBootstrap({
        dir: target,
        template: "vx-spa",
      });

      expect(result.targetDir).toBe(target);
      expect(result.localVoydRoot).toBe(repoRoot);
      expect(result.files).toContain("index.html");
      expect(result.files).toContain("src/main.voyd");
      expect(result.files).toContain("src/app/model.voyd");
      expect(result.files).toContain("src/app/update.voyd");
      expect(result.files).toContain("src/app/ui.voyd");
      expect(result.nextSteps).toEqual(["npm install", "npm run dev"]);

      const packageJson = JSON.parse(
        await readFile(resolve(target, "package.json"), "utf8"),
      ) as {
        name: string;
        scripts: Record<string, string>;
        dependencies: Record<string, string>;
        devDependencies: Record<string, string>;
      };
      expect(packageJson.name).toBe("my-app");
      expect(packageJson.scripts.dev).toBe("vite");
      expect(packageJson.scripts.build).toBe("npm run typecheck && vite build");
      expect(packageJson.scripts.typecheck).toBe("npm run voyd:build && tsc --noEmit");
      expect(packageJson.dependencies["@voyd-lang/sdk"]).toContain("packages/sdk");
      expect(packageJson.dependencies["@voyd-lang/vx-dom"]).toContain("packages/vx-dom");
      expect(packageJson.dependencies["@voyd-lang/compiler"]).toContain("packages/compiler");
      expect(packageJson.devDependencies["@voyd-lang/cli"]).toContain("apps/cli");
      expect(packageJson.devDependencies.tsx).toBe("^4.20.4");
      expect(packageJson.devDependencies.tailwindcss).toBe("^4.3.0");
      expect(packageJson.devDependencies["@tailwindcss/vite"]).toBe("^4.3.0");

      const tsConfig = await readFile(resolve(target, "tsconfig.json"), "utf8");
      expect(tsConfig).not.toContain('"node"');

      const viteConfig = await readFile(resolve(target, "vite.config.mjs"), "utf8");
      expect(viteConfig).toContain("compileVoyd");
      expect(viteConfig).toContain('server.watcher.add("src")');
      expect(viteConfig).toContain("while (completedCompilation < requestedCompilation)");
      expect(viteConfig).toContain("if (await compileLatest())");
      expect(viteConfig).toContain('includes("/src/generated/")');
      expect(viteConfig).toContain('resolve: { conditions: ["development"] }');

      const compileScript = await readFile(resolve(target, "scripts/compile-voyd.mjs"), "utf8");
      expect(compileScript).toContain('resolve(rootDir, "src/generated/.staging")');
      expect(compileScript).toContain("promoteGeneratedFiles");

      const runVoyd = await readFile(resolve(target, "scripts/run-voyd.mjs"), "utf8");
      expect(runVoyd).toContain("const useVoydSources = true");
      expect(runVoyd).toContain('VOYD_DEV: "1"');

      const css = await readFile(resolve(target, "src/style.css"), "utf8");
      expect(css).toContain('@import "tailwindcss";');
      expect(css).toContain('@source "./**/*.voyd";');

      const mainTs = await readFile(resolve(target, "src/main.ts"), "utf8");
      expect(mainTs).toContain('from "@voyd-lang/sdk/js-host"');
      expect(mainTs).toContain('from "./generated/main.wasm?url"');

      const mainVoyd = await readFile(resolve(target, "src/main.voyd"), "utf8");
      expect(mainVoyd).toContain("program({ init: initial_model, step: step, view })");
      expect(mainVoyd).not.toContain('class="min-h-screen');

      const appView = await readFile(resolve(target, "src/app/ui.voyd"), "utf8");
      expect(appView).toContain('class="min-h-screen');
      expect(appView).toContain("to_string(model.count)");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);

  it("scaffolds the web-ssr starter", async () => {
    const root = await createTempDir();
    const target = resolve(root, "mini wiki");
    try {
      const result = await runBootstrap({
        dir: target,
        template: "web-ssr",
      });

      expect(result.targetDir).toBe(target);
      expect(result.localVoydRoot).toBe(repoRoot);
      expect(result.files).toContain("src/main.voyd");
      expect(result.files).toContain("src/client.ts");
      expect(result.files).toContain("src/app/ui.voyd");
      expect(result.files).toContain("src/server/page.voyd");
      expect(result.files).toContain("scripts/diagnostics.mjs");
      expect(result.files).toContain("data/articles/home.md");
      expect(result.nextSteps).toEqual(["npm install", "npm run dev"]);

      const packageJson = JSON.parse(
        await readFile(resolve(target, "package.json"), "utf8"),
      ) as {
        name: string;
        scripts: Record<string, string>;
        dependencies: Record<string, string>;
        devDependencies: Record<string, string>;
      };
      expect(packageJson.name).toBe("mini-wiki");
      expect(packageJson.scripts.dev).toBe(
        "node --conditions=development --import tsx scripts/dev.mjs",
      );
      expect(packageJson.scripts.build).toBe(
        "npm run typecheck && vite build && node --conditions=development --import tsx scripts/check-voyd.mjs",
      );
      expect(packageJson.dependencies["@voyd-lang/web"]).toContain("packages/web");
      expect(packageJson.dependencies["@voyd-lang/vx-dom"]).toContain("packages/vx-dom");
      expect(packageJson.dependencies["@voyd-lang/compiler"]).toContain("packages/compiler");
      expect(packageJson.dependencies["@voyd-lang/std"]).toContain("packages/std");
      expect(packageJson.devDependencies["@voyd-lang/cli"]).toContain("apps/cli");
      expect(packageJson.devDependencies.tsx).toBe("^4.20.4");
      expect(packageJson.devDependencies.tailwindcss).toBe("^4.3.0");
      expect(packageJson.devDependencies["@tailwindcss/vite"]).toBe("^4.3.0");

      const serverScript = await readFile(resolve(target, "scripts/serve.mjs"), "utf8");
      expect(serverScript).toContain("serveWebApp");
      expect(serverScript).toContain("bufferSize: 1024 * 1024");
      expect(serverScript).toContain("optimize = true");
      expect(serverScript).toContain('process.once("SIGINT"');
      expect(serverScript).toContain("app.closed.then");
      expect(serverScript).toContain("Voyd server stopped unexpectedly");
      expect(serverScript).toContain("throw compilationError(result.diagnostics)");
      expect(serverScript).toContain("console.error(errorMessage(error))");

      const diagnosticsPath = resolve(target, "scripts/diagnostics.mjs");
      const pagePath = resolve(target, "src/server/page.voyd");
      const pageSource = await readFile(pagePath, "utf8");
      const diagnosticStart = pageSource.indexOf("Response::ok()");
      const diagnostic = {
        code: "TY0006",
        message: "function 'missing' is not defined",
        severity: "error",
        phase: "typing",
        span: {
          file: pagePath,
          start: diagnosticStart,
          end: diagnosticStart + "Response::ok".length,
        },
      };
      const diagnosticLine = pageSource.slice(0, diagnosticStart).split("\n").length;
      const diagnosticColumn = diagnosticStart -
        pageSource.lastIndexOf("\n", diagnosticStart - 1);
      const diagnosticsProbe = [
        `const diagnostics = await import(${JSON.stringify(pathToFileURL(diagnosticsPath).href)});`,
        `const diagnostic = ${JSON.stringify(diagnostic)};`,
        "const error = diagnostics.compilationError([diagnostic]);",
        "console.log(JSON.stringify({",
        "  formatted: diagnostics.formatDiagnostic(diagnostic),",
        "  message: diagnostics.errorMessage(error),",
        "}));",
      ].join("\n");
      const diagnosticsResult = JSON.parse(execFileSync(
        process.execPath,
        ["--input-type=module", "--eval", diagnosticsProbe],
        { encoding: "utf8" },
      )) as { formatted: string; message: string };
      const formattedDiagnostic = diagnosticsResult.formatted;
      expect(formattedDiagnostic).toContain(
        `${pagePath}:${diagnosticLine}:${diagnosticColumn}`,
      );
      expect(formattedDiagnostic).toContain("TY0006: function 'missing' is not defined");
      expect(diagnosticsResult.message).toBe(formattedDiagnostic);

      const readme = await readFile(resolve(target, "README.md"), "utf8");
      expect(readme).toContain("npm run dev");
      expect(readme).toContain("src/app");
      expect(readme).toContain("render identically");
      expect(readme).toContain(repoRoot);
      expect(readme).toContain("links the complete local Voyd dependency set");

      const gitignore = await readFile(resolve(target, ".gitignore"), "utf8");
      expect(gitignore).toContain("data/articles/*.md");
      expect(gitignore).toContain("!data/articles/home.md");
      expect(gitignore).toContain("src/generated");
      expect(gitignore).toContain(".voyd-dev");

      const devScript = await readFile(resolve(target, "scripts/dev.mjs"), "utf8");
      expect(devScript).toContain("watchSource(sourceDir");
      expect(devScript.indexOf("watchSource(sourceDir")).toBeLessThan(
        devScript.indexOf("await queueRebuild({ failFast: true })"),
      );
      expect(devScript).toContain("/\\.(voyd|ts|css)$/");
      expect(devScript).toContain("void queueRebuild()");
      expect(devScript).toContain("while (rebuildRequested)");
      expect(devScript).toContain("console.error(errorMessage(error))");
      expect(devScript).toContain("await checkServer({ optimize: false })");
      expect(devScript.indexOf("await checkServer")).toBeLessThan(
        devScript.indexOf('await run("vite"'),
      );
      expect(devScript.indexOf('await run("vite"')).toBeLessThan(
        devScript.lastIndexOf("await checkServer"),
      );
      expect(devScript.lastIndexOf("await checkServer")).toBeLessThan(
        devScript.indexOf('await app.close("restart")'),
      );
      expect(devScript).toContain('"--outDir", stagedPublicDir');
      expect(devScript).toContain("await promoteAssets()");
      expect(devScript).toContain('resolve(rootDir, "public/assets")');
      expect(devScript).not.toContain('rename(livePublicDir');

      const watchScript = await readFile(resolve(target, "scripts/watch-source.mjs"), "utf8");
      expect(watchScript).toContain("reconcileWatchers");
      expect(watchScript).toContain("onChange();");
      expect(watchScript).toContain('watcher.on("error"');
      expect(watchScript).toContain("scheduleWatchRetry");

      const checkScript = await readFile(resolve(target, "scripts/check-voyd.mjs"), "utf8");
      expect(checkScript).toContain("optimize: true");
      expect(checkScript).toContain("compileClient");
      expect(checkScript).toContain('from "./diagnostics.mjs"');

      const viteConfig = await readFile(resolve(target, "vite.config.mjs"), "utf8");
      expect(viteConfig).toContain("compileClient");
      expect(viteConfig).toContain('entryFileNames: "assets/client.js"');
      expect(viteConfig).toContain('assetFileNames: "assets/[name][extname]"');
      expect(viteConfig).toContain('resolve: { conditions: ["development"] }');

      const clientTs = await readFile(resolve(target, "src/client.ts"), "utf8");
      expect(clientTs).toContain("createVoydHost");
      expect(clientTs).toContain("hydrateVxApp");
      expect(clientTs).toContain('readVoydHydrationRoot("article-editor")');
      expect(clientTs).toContain("onHydrationMismatch");
      expect(clientTs).toContain('import.meta.env.MODE === "development"');
      expect(clientTs).toContain("./generated/client.wasm?url");
      expect(clientTs).toContain("hydration.container.prepend(notice)");
      expect(clientTs).not.toContain("hydration.container.textContent =");

      const clientVoyd = await readFile(resolve(target, "src/client.voyd"), "utf8");
      expect(clientVoyd).toContain("pub fn app() -> Program<Model, Msg>");
      expect(clientVoyd).toContain("src::app::ui::view");
      expect(clientVoyd).not.toContain("obj Model");

      const sharedView = await readFile(resolve(target, "src/app/ui.voyd"), "utf8");
      expect(sharedView).toContain("attrs.push(html_event_handler<Msg>(");
      expect(sharedView).toContain("on_input={(event: InputEvent) -> Msg =>");
      expect(sharedView).not.toContain("static_view");
      expect(sharedView).not.toContain("interactive");
      expect(sharedView).toContain('type="submit" disabled={model.saving}');

      const pageVoyd = await readFile(resolve(target, "src/server/page.voyd"), "utf8");
      expect(pageVoyd).toContain("src::app::ui::view");
      expect(pageVoyd).toContain('<div id="article-editor">{view(model)}</div>');
      expect(pageVoyd).not.toContain("static_view");
      expect(pageVoyd).toContain("document(");
      expect(pageVoyd).toContain("hydrate_named<Model>(");
      expect(pageVoyd).toContain('id: "article-editor"');

      const css = await readFile(resolve(target, "src/style.css"), "utf8");
      expect(css).toContain('@import "tailwindcss";');
      expect(css).toContain('@source "./**/*.voyd";');

      const mainVoyd = await readFile(resolve(target, "src/main.voyd"), "utf8");
      expect(mainVoyd).toContain("pub fn main(): (server::HttpServer");
      expect(mainVoyd).toContain("tasks::TaskRuntime");
      expect(mainVoyd).toContain("max_body_bytes: 65536");
      expect(mainVoyd).toContain('adopt(serve_dir("./public"))');
      expect(mainVoyd).not.toContain('"/api/articles"');
      expect(mainVoyd).toContain('get("/wiki") do(ctx: Context):');
      expect(mainVoyd).toContain('post("/wiki/:slug/body") do(ctx: Context):');
      expect(mainVoyd).toContain('post("/wiki/:slug") do(ctx: Context):');
      expect(mainVoyd).toContain("save_form_response(ctx)");
      expect(mainVoyd).toContain("Response::bad_request().text(error.message)");
      expect(mainVoyd).toContain('invalid_request("invalid article slug")');
      expect(mainVoyd).toContain('invalid_request("missing body form field")');
      expect(mainVoyd).not.toContain('class="min-h-screen');

      const articlesVoyd = await readFile(resolve(target, "src/server/articles.voyd"), "utf8");
      expect(articlesVoyd).toContain("request_body(ctx: Context) -> Result<String, HttpError>");
      expect(articlesVoyd).toContain("article_slug_from(ctx: Context) -> Option<String>");
      expect(articlesVoyd).toContain("form_body(input: String) -> Option<String>");
      expect(articlesVoyd).not.toContain("Err:\n      String::init()");

      const voydSources = await Promise.all(result.files
        .filter((file) => file.endsWith(".voyd"))
        .map((file) => readFile(resolve(target, file), "utf8")));
      expect(voydSources.join("\n")).not.toContain(".as_slice().to_string()");

      const parityProbe = resolve(target, "src/parity-probe.voyd");
      await writeFile(parityProbe, `use src::app::model::{ Model, initial_model }
use src::app::update::Msg
use src::app::ui::view
use pkg::web::all
use std::vx::all

fn model() -> Model
  initial_model(slug: "home", title: "Mini Voydpedia", body: "Shared view")

pub fn server_html() -> String
  render(view(model()))

pub fn client_tree() -> Html<Msg>
  view(model())
`);
      const sdk = createSdk();
      const roots = {
        src: resolve(target, "src"),
        pkgDirs: [resolve(repoRoot, "packages")],
      };
      const compiled = expectCompileSuccess(await sdk.compile({
        entryPath: parityProbe,
        roots,
        optimizationLevel: "release",
      }));
      const host = await createVoydHost({
        wasm: compiled.wasm,
        bufferSize: 1024 * 1024,
      });
      const serverHtml = await host.run<string>("server_html");
      expect(host.retainedCallbacks.size()).toBe(0);
      const clientTree = await host.run("client_tree");

      const container = document.createElement("div");
      container.innerHTML = serverHtml;
      const serverForm = container.querySelector("form");
      const onHydrationMismatch = vi.fn();
      const renderer = createVxDomRenderer(container, {
        handlers: host.retainedCallbacks,
        onHydrationMismatch,
      });
      renderer.hydrate(clientTree);

      expect(onHydrationMismatch).not.toHaveBeenCalled();
      expect(container.querySelector("form")).toBe(serverForm);
      renderer.dispose();
      expect(host.retainedCallbacks.size()).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 300_000);

  it("can scaffold against published Voyd packages from a local checkout", async () => {
    const root = await createTempDir();
    const target = resolve(root, "published-app");
    try {
      const result = await runBootstrap({
        dir: target,
        template: "web-ssr",
        usePublished: true,
      });
      expect(result.localVoydRoot).toBeUndefined();

      const packageJson = JSON.parse(
        await readFile(resolve(target, "package.json"), "utf8"),
      ) as {
        scripts: Record<string, string>;
        dependencies: Record<string, string>;
        devDependencies: Record<string, string>;
      };
      expect(packageJson.scripts.dev).toBe("node scripts/dev.mjs");
      expect(packageJson.dependencies["@voyd-lang/sdk"]).toMatch(/^\^/);
      expect(packageJson.dependencies["@voyd-lang/web"]).toMatch(/^\^/);
      expect(packageJson.dependencies["@voyd-lang/compiler"]).toBeUndefined();
      expect(packageJson.devDependencies["@voyd-lang/cli"]).toMatch(/^\^/);
      expect(packageJson.devDependencies.tsx).toBeUndefined();

      const runVoyd = await readFile(resolve(target, "scripts/run-voyd.mjs"), "utf8");
      expect(runVoyd).toContain("const useVoydSources = false");
      const viteConfig = await readFile(resolve(target, "vite.config.mjs"), "utf8");
      expect(viteConfig).not.toContain('conditions: ["development"]');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("prints a dry run without writing files", async () => {
    const root = await createTempDir();
    const target = resolve(root, "dry-run-app");
    try {
      const result = await runBootstrap({
        dir: target,
        template: "vx-spa",
        dryRun: true,
      });

      expect(result.dryRun).toBe(true);
      expect(result.files).toContain("package.json");
      expect(existsSync(target)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("allows dry-run previews for non-empty directories", async () => {
    const root = await createTempDir();
    try {
      await writeFile(resolve(root, "README.md"), "already here");

      const result = await runBootstrap({
        dir: root,
        template: "vx-spa",
        dryRun: true,
      });

      expect(result.dryRun).toBe(true);
      expect(result.files).toContain("package.json");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses to write into a non-empty directory without force", async () => {
    const root = await createTempDir();
    try {
      await writeFile(resolve(root, "README.md"), "already here");

      await expect(
        runBootstrap({
          dir: root,
          template: "vx-spa",
        }),
      ).rejects.toThrow("Bootstrap target is not empty");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("quotes the printed cd target", () => {
    const lines: string[] = [];
    const log = vi
      .spyOn(console, "log")
      .mockImplementation((...values) => lines.push(values.join(" ")));

    try {
      printBootstrapResult({
        targetDir: "/tmp/my app",
        template: "vx-spa",
        dryRun: false,
        localVoydRoot: undefined,
        files: ["package.json"],
        nextSteps: ["npm install"],
      });
    } finally {
      log.mockRestore();
    }

    expect(lines).toContain("  cd '/tmp/my app'");
  });
});
