import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { printBootstrapResult, runBootstrap } from "../bootstrap/index.js";

const createTempDir = () => mkdtemp(resolve(tmpdir(), "voyd-bootstrap-"));

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
