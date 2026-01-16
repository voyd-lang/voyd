import { describe, expect, it } from "vitest";
import { build } from "vite";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { Buffer } from "node:buffer";

type SmokeRunner = () => Promise<number>;

type BrowserContext = {
  __voydBrowserSmoke__?: SmokeRunner;
  globalThis: BrowserContext;
  window: BrowserContext;
  self: BrowserContext;
  console: Console;
  TextEncoder: typeof TextEncoder;
  TextDecoder: typeof TextDecoder;
  WebAssembly: typeof WebAssembly;
  Uint8Array: typeof Uint8Array;
  ArrayBuffer: typeof ArrayBuffer;
  DataView: typeof DataView;
  BigInt: typeof BigInt;
  btoa: (data: string) => string;
  atob: (data: string) => string;
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
};

const createBrowserContext = (): BrowserContext => {
  const btoaImpl =
    globalThis.btoa ??
    ((data: string) => Buffer.from(data, "binary").toString("base64"));
  const atobImpl =
    globalThis.atob ??
    ((data: string) => Buffer.from(data, "base64").toString("binary"));

  const context = {
    console,
    TextEncoder,
    TextDecoder,
    WebAssembly,
    Uint8Array,
    ArrayBuffer,
    DataView,
    BigInt,
    btoa: btoaImpl,
    atob: atobImpl,
    setTimeout,
    clearTimeout,
  } as BrowserContext;

  context.globalThis = context;
  context.window = context;
  context.self = context;

  return context;
};

describe("browser bundle smoke", () => {
  it("bundles and runs the browser compiler", async () => {
    const entry = fileURLToPath(
      new URL("./__fixtures__/browser-bundle-entry.ts", import.meta.url)
    );
    const outDir = await mkdtemp(join(tmpdir(), "voyd-browser-"));

    try {
      const projectRoot = fileURLToPath(new URL("../../../../", import.meta.url));
      const packagesRoot = join(projectRoot, "packages");

      await build({
        root: projectRoot,
        logLevel: "silent",
        resolve: {
          alias: {
            "@voyd/lib": join(packagesRoot, "lib/src/lib"),
            "@voyd/compiler": join(packagesRoot, "compiler/src"),
            "@voyd/browser-compiler": join(packagesRoot, "browser-compiler/src"),
          },
        },
        build: {
          lib: {
            entry,
            name: "VoydBrowserSmoke",
            formats: ["iife"],
            fileName: () => "bundle.js",
          },
          rollupOptions: {
            external: [],
            output: {
              inlineDynamicImports: true,
            },
          },
          outDir,
          emptyOutDir: true,
          minify: false,
          sourcemap: false,
          target: "es2020",
        },
      });

      const bundlePath = join(outDir, "bundle.js");
      const code = await readFile(bundlePath, "utf8");

      expect(code).not.toContain("node:");

      const context = createBrowserContext();
      runInNewContext(code, context, { filename: "bundle.js" });

      const runner = context.__voydBrowserSmoke__;
      expect(typeof runner).toBe("function");
      const size = await runner!();
      expect(size).toBeGreaterThan(0);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });
});
