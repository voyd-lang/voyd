import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

const failOnLoad = (name: string) => () => {
  throw new Error(`${name} should not be loaded for --run-wasm`);
};

describe("exec", () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("keeps --run-wasm off compiler and doc startup paths", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "voyd-cli-exec-"));
    const wasmPath = resolve(root, "module.wasm");
    await writeFile(wasmPath, new Uint8Array([0x00, 0x61, 0x73, 0x6d]));

    const printValue = vi.fn();
    const run = vi.fn(async () => 42);
    const createVoydHost = vi.fn(async () => ({ run }));
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
      code?: number,
    ) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as never);

    vi.doMock("../config/index.js", () => ({
      getConfig: () => ({
        index: wasmPath,
        runWasm: true,
        entry: "main",
        doc: false,
        docFormat: "html" as const,
      }),
    }));
    vi.doMock("../output.js", () => ({
      printJson: vi.fn(),
      printValue,
    }));
    vi.doMock("@voyd/sdk", failOnLoad("@voyd/sdk"));
    vi.doMock("@voyd/sdk/compiler", failOnLoad("@voyd/sdk/compiler"));
    vi.doMock("@voyd/sdk/doc-generation", failOnLoad("@voyd/sdk/doc-generation"));
    vi.doMock("@voyd/lib/resolve-std.js", failOnLoad("@voyd/lib/resolve-std.js"));
    vi.doMock("../package-dirs.js", failOnLoad("./package-dirs.js"));
    vi.doMock("../test-runner.js", failOnLoad("./test-runner.js"));
    vi.doMock("@voyd/sdk/js-host", () => ({
      createVoydHost,
    }));

    try {
      const { exec } = await import("../exec.js");
      await expect(exec()).resolves.toBeUndefined();
      expect(createVoydHost).toHaveBeenCalledOnce();
      expect(run).toHaveBeenCalledWith("main");
      expect(printValue).toHaveBeenCalledWith(42);
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
