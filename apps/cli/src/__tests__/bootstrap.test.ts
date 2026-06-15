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
    throw new Error(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
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
      expect(packageJson.scripts.build).toBe("vite build");
      expect(packageJson.dependencies["@voyd-lang/vx-dom"]).toMatch(/^\^/);
      expect(packageJson.devDependencies.tailwindcss).toBe("^4.3.0");
      expect(packageJson.devDependencies["@tailwindcss/vite"]).toBe("^4.3.0");

      const viteConfig = await readFile(resolve(target, "vite.config.mjs"), "utf8");
      expect(viteConfig).toContain("compileVoyd");
      expect(viteConfig).toContain('server.watcher.add("src")');

      const css = await readFile(resolve(target, "src/style.css"), "utf8");
      expect(css).toContain('@import "tailwindcss";');
      expect(css).toContain('@source "./**/*.voyd";');

      const mainTs = await readFile(resolve(target, "src/main.ts"), "utf8");
      expect(mainTs).toContain('from "@voyd-lang/sdk/js-host"');
      expect(mainTs).toContain('from "./generated/main.wasm?url"');

      const mainVoyd = await readFile(resolve(target, "src/main.voyd"), "utf8");
      expect(mainVoyd).toContain("pub fn init() -> Model");
      expect(mainVoyd).toContain('class="min-h-screen');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

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
      expect(packageJson.scripts.build).toBe("vite build && node scripts/check-voyd.mjs");
      expect(packageJson.dependencies["@voyd-lang/web"]).toMatch(/^\^/);
      expect(packageJson.dependencies["@voyd-lang/vx-dom"]).toMatch(/^\^/);
      expect(packageJson.devDependencies["@voyd-lang/cli"]).toMatch(/^\^/);
      expect(packageJson.devDependencies.tailwindcss).toBe("^4.3.0");
      expect(packageJson.devDependencies["@tailwindcss/vite"]).toBe("^4.3.0");

      const serverScript = await readFile(resolve(target, "scripts/serve.mjs"), "utf8");
      expect(serverScript).toContain("serveWebApp");
      expect(serverScript).toContain("bufferSize: 1024 * 1024");
      expect(serverScript).toContain("optimize = true");
      expect(serverScript).toContain("await waitForShutdown");
      expect(serverScript).toContain('process.once("SIGINT"');

      const readme = await readFile(resolve(target, "README.md"), "utf8");
      expect(readme).toContain("npm run dev");
      expect(readme).toContain("data/articles");
      expect(readme).toContain("max_body_bytes");

      const gitignore = await readFile(resolve(target, ".gitignore"), "utf8");
      expect(gitignore).toContain("data/articles/*.md");
      expect(gitignore).toContain("!data/articles/home.md");
      expect(gitignore).toContain("src/generated");

      const devScript = await readFile(resolve(target, "scripts/dev.mjs"), "utf8");
      expect(devScript).toContain("watchTree(sourceDir)");
      expect(devScript).toContain('filePath.endsWith("client.voyd")');
      expect(devScript).toContain('filePath.endsWith(".voyd")');
      expect(devScript).toContain("queueBuild();");
      expect(devScript).toContain("queueRestart();");

      const checkScript = await readFile(resolve(target, "scripts/check-voyd.mjs"), "utf8");
      expect(checkScript).toContain("optimize: true");
      expect(checkScript).toContain("compileClientVoyd");

      const viteConfig = await readFile(resolve(target, "vite.config.mjs"), "utf8");
      expect(viteConfig).toContain("compileClientVoyd");
      expect(viteConfig).toContain('entryFileNames: "assets/client.js"');
      expect(viteConfig).toContain('assetFileNames: "assets/[name][extname]"');

      const clientTs = await readFile(resolve(target, "src/client.ts"), "utf8");
      expect(clientTs).toContain("createVoydHost");
      expect(clientTs).toContain("hydrateVxApp");
      expect(clientTs).toContain("./generated/client.wasm?url");

      const clientVoyd = await readFile(resolve(target, "src/client.voyd"), "utf8");
      expect(clientVoyd).toContain("pub fn app() -> Program<ClientArticle, Msg>");
      expect(clientVoyd).toContain("on_input={(event: InputEvent) -> Msg");
      expect(clientVoyd).toContain("state_kind: String");
      expect(clientVoyd).toContain("tasks::detach do:");
      expect(clientVoyd).toContain("Cmd<Msg>::perform<i32>");
      expect(clientVoyd).toContain("on_click={Msg::Save {}}");
      expect(clientVoyd).toContain("http_client::post");

      const css = await readFile(resolve(target, "src/style.css"), "utf8");
      expect(css).toContain('@import "tailwindcss";');
      expect(css).toContain('@source "./**/*.voyd";');

      const mainVoyd = await readFile(resolve(target, "src/main.voyd"), "utf8");
      expect(mainVoyd).toContain("pub fn main(): (server::HttpServer");
      expect(mainVoyd).toContain("tasks::TaskRuntime");
      expect(mainVoyd).toContain("server::serve_each");
      expect(mainVoyd).toContain("server::ServeTaskPolicy::sequential()");
      expect(mainVoyd).toContain("max_body_bytes: 65536");
      expect(mainVoyd).toContain('adopt(serve_dir("./public".as_slice()))');
      expect(mainVoyd).not.toContain('"/api/articles"');
      expect(mainVoyd).toContain('.get_context("/wiki".as_slice()');
      expect(mainVoyd).toContain('.post_context("/wiki/:slug/body".as_slice()');
      expect(mainVoyd).toContain('.post_context("/wiki/:slug".as_slice()');
      expect(mainVoyd).toContain("request_text_body(ctx)");
      expect(mainVoyd).toContain('form_article_body(request_text_body(ctx))');
      expect(mainVoyd).toContain('parse_query(input).get("body".as_slice())');
      expect(mainVoyd).toContain("write_file_string(article_path(slug), body)");
      expect(mainVoyd).toContain("fn is_slug_rune(rune: i32) -> bool");
      expect(mainVoyd).toContain("not is_slug_rune(rune)");
      expect(mainVoyd).toContain("state_kind: String");
      expect(mainVoyd).toContain("{article.state_message}");
      expect(mainVoyd).not.toContain('>Saved</span>');
      expect(mainVoyd).toContain('href="/assets/client.css"');
      expect(mainVoyd).toContain("document<MsgPack, ClientArticle>");

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
  }, 120_000);

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
