import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createSdk, type CompileResult } from "@voyd-lang/sdk";
import { describe, expect, it, vi } from "vitest";
import { printBootstrapResult, runBootstrap } from "../bootstrap/index.js";

const createTempDir = () => mkdtemp(resolve(tmpdir(), "voyd-bootstrap-"));
const repoRoot = resolve(import.meta.dirname, "../../../..");

const expectCompileSuccess = (
  result: CompileResult,
): Extract<CompileResult, { success: true }> => {
  if (!result.success) {
    throw new Error(result.diagnostics
      .map((diagnostic) => `${diagnostic.span.file}: ${diagnostic.message}`)
      .join("\n"));
  }
  expect(result.success).toBe(true);
  return result;
};

describe("runBootstrap", () => {
  it("scaffolds the vx-spa starter", async () => {
    const root = await createTempDir();
    const target = resolve(root, "my app");
    try {
      const result = await runBootstrap({
        dir: target,
        template: "vx-spa",
      });

      expect(result.targetDir).toBe(target);
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
      expect(packageJson.dependencies["@voyd-lang/vx-dom"]).toMatch(/^\^/);
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

      const compileScript = await readFile(resolve(target, "scripts/compile-voyd.mjs"), "utf8");
      expect(compileScript).toContain('resolve(rootDir, "src/generated/.staging")');
      expect(compileScript).toContain("promoteGeneratedFiles");

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

      expectCompileSuccess(await createSdk().compile({
        entryPath: resolve(target, "src/main.voyd"),
        optimize: true,
        roots: {
          src: resolve(target, "src"),
          pkgDirs: [resolve(repoRoot, "packages")],
        },
      }));
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
      expect(result.files).toContain("src/main.voyd");
      expect(result.files).toContain("src/client.ts");
      expect(result.files).toContain("src/app/ui.voyd");
      expect(result.files).toContain("src/server/page.voyd");
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
      expect(packageJson.scripts.dev).toBe("node scripts/dev.mjs");
      expect(packageJson.scripts.build).toBe(
        "npm run typecheck && vite build && node scripts/check-voyd.mjs",
      );
      expect(packageJson.dependencies["@voyd-lang/web"]).toMatch(/^\^/);
      expect(packageJson.dependencies["@voyd-lang/vx-dom"]).toMatch(/^\^/);
      expect(packageJson.devDependencies["@voyd-lang/cli"]).toMatch(/^\^/);
      expect(packageJson.devDependencies.tailwindcss).toBe("^4.3.0");
      expect(packageJson.devDependencies["@tailwindcss/vite"]).toBe("^4.3.0");

      const serverScript = await readFile(resolve(target, "scripts/serve.mjs"), "utf8");
      expect(serverScript).toContain("serveWebApp");
      expect(serverScript).toContain("bufferSize: 1024 * 1024");
      expect(serverScript).toContain("optimize = true");
      expect(serverScript).toContain('process.once("SIGINT"');
      expect(serverScript).toContain("app.closed.then");
      expect(serverScript).toContain("Voyd server stopped unexpectedly");

      const readme = await readFile(resolve(target, "README.md"), "utf8");
      expect(readme).toContain("npm run dev");
      expect(readme).toContain("src/app");
      expect(readme).toContain("render identically");

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

      const viteConfig = await readFile(resolve(target, "vite.config.mjs"), "utf8");
      expect(viteConfig).toContain("compileClient");
      expect(viteConfig).toContain('entryFileNames: "assets/client.js"');
      expect(viteConfig).toContain('assetFileNames: "assets/[name][extname]"');

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
      expect(sharedView).toContain("on_submit={on_submit_with(");
      expect(sharedView).toContain("attrs.push(event_payload_handler<InputEvent, Msg>(");
      expect(sharedView).toContain("pub fn static_view(model: Model)");
      expect(sharedView).toContain("editor(model, interactive: false)");
      expect(sharedView).toContain('type="submit" disabled={model.saving}');

      const pageVoyd = await readFile(resolve(target, "src/server/page.voyd"), "utf8");
      expect(pageVoyd).toContain("src::app::ui::static_view");
      expect(pageVoyd).toContain('<div id="article-editor">{static_view(model)}</div>');
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

      const sdk = createSdk();
      expectCompileSuccess(
        await sdk.compile({
          entryPath: resolve(target, "src/main.voyd"),
          optimize: true,
          roots: {
            src: resolve(target, "src"),
            pkgDirs: [resolve(repoRoot, "packages")],
          },
        }),
      );
      expectCompileSuccess(
        await sdk.compile({
          entryPath: resolve(target, "src/client.voyd"),
          optimize: true,
          roots: {
            src: resolve(target, "src"),
            pkgDirs: [resolve(repoRoot, "packages")],
          },
        }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 300_000);

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
        files: ["package.json"],
        nextSteps: ["npm install"],
      });
    } finally {
      log.mockRestore();
    }

    expect(lines).toContain("  cd '/tmp/my app'");
  });
});
