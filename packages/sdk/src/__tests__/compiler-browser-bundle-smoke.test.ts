import { describe, expect, it } from "vitest";
import { build } from "vite";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Buffer } from "node:buffer";

type KitchenSinkResult = {
  compilerSize: number;
  vsxSize: number;
};

type SmokeRunner = () => Promise<KitchenSinkResult>;

type BrowserContext = {
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
  const bundleAndRun = async ({
    entryUrl,
    runnerExportName,
  }: {
    entryUrl: URL;
    runnerExportName: string;
  }): Promise<KitchenSinkResult> => {
    const entry = fileURLToPath(entryUrl);
    const outDir = await mkdtemp(join(tmpdir(), "voyd-browser-"));

    try {
      const projectRoot = fileURLToPath(new URL("../../../../", import.meta.url));
      const packagesRoot = join(projectRoot, "packages");

      await build({
        configFile: false,
        root: projectRoot,
        logLevel: "silent",
        resolve: {
          alias: {
            "@voyd/lib": join(packagesRoot, "lib/src/lib"),
            "@voyd/compiler": join(packagesRoot, "compiler/src"),
            "@voyd/js-host": join(packagesRoot, "js-host/src"),
            "@voyd/sdk": join(packagesRoot, "sdk/src"),
          },
        },
        build: {
          lib: {
            entry,
            name: "VoydBrowserSmoke",
            formats: ["es"],
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
          target: "esnext",
        },
      });

      const bundlePath = join(outDir, "bundle.js");
      const code = await readFile(bundlePath, "utf8");

      const nodeSpecifier = /["']node:[^"']+["']/;
      expect(nodeSpecifier.test(code)).toBe(false);

      const context = createBrowserContext();
      const previous = {
        window: globalThis.window,
        self: globalThis.self,
        process: globalThis.process,
        btoa: globalThis.btoa,
        atob: globalThis.atob,
      };
      Object.assign(globalThis, {
        window: globalThis,
        self: globalThis,
        process: undefined,
        btoa: context.btoa,
        atob: context.atob,
        TextEncoder,
        TextDecoder,
        WebAssembly,
        Uint8Array,
        ArrayBuffer,
        DataView,
        BigInt,
      });

      try {
        const bundleModule = await import(pathToFileURL(bundlePath).href) as Record<
          string,
          unknown
        >;
        const runner = bundleModule[runnerExportName];
        expect(typeof runner).toBe("function");
        return (runner as SmokeRunner)();
      } finally {
        Object.assign(globalThis, previous);
      }
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  };

  it("bundles and runs compiler + vsx browser smoke in one build", { timeout: 90000 }, async () => {
    const result = await bundleAndRun({
      entryUrl: new URL(
        "./__fixtures__/browser-bundle-kitchen-sink-entry.ts",
        import.meta.url,
      ),
      runnerExportName: "runBrowserKitchenSinkSmoke",
    });
    expect(result.compilerSize).toBeGreaterThan(0);
    expect(result.vsxSize).toBeGreaterThan(0);
  });
});
