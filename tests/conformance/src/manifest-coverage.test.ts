import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { loadConformanceManifest } from "./manifest.js";

const registeredPrefixes = new Set([
  "effects",
  "modules",
  "runtime",
  "syntax",
  "typing",
  "wasm",
]);

describe("conformance manifest coverage", () => {
  it("routes every suite to a test file", () => {
    const uncovered = loadConformanceManifest()
      .suites.map((suite) => suite.id.split(".")[0])
      .filter((prefix) => !registeredPrefixes.has(prefix));

    expect(uncovered).toEqual([]);
  });

  const currentAdapterIt = process.env.VOYD_CONFORMANCE_ADAPTER ? it.skip : it;

  currentAdapterIt(
    "normalizes only genuine WebAssembly runtime traps",
    async () => {
      const { normalizeRuntimeTrap } =
        await import("./current-compiler-adapter.js");

      expect(
        normalizeRuntimeTrap(new WebAssembly.RuntimeError("boom")),
      ).toEqual({
        name: "RuntimeError",
        message: "boom",
      });
      expect(() => normalizeRuntimeTrap(new Error("adapter failure"))).toThrow(
        "adapter failure",
      );
    },
  );

  it("loads an external adapter without importing the current SDK", async () => {
    const previousAdapter = process.env.VOYD_CONFORMANCE_ADAPTER;
    process.env.VOYD_CONFORMANCE_ADAPTER = fileURLToPath(
      new URL("fixtures/external-compiler-adapter.mjs", import.meta.url),
    );
    vi.resetModules();
    vi.doMock("@voyd-lang/sdk", () => {
      throw new Error("the current SDK adapter was imported");
    });

    try {
      const { loadCompilerAdapter } =
        await import("./load-compiler-adapter.js");
      const adapter = await loadCompilerAdapter();

      expect(await adapter.compile({ entryPath: "mock-entry.voyd" })).toEqual({
        success: false,
        diagnostics: [
          {
            code: "MOCK0001",
            message: "external adapter received mock-entry.voyd",
          },
        ],
      });
    } finally {
      if (previousAdapter !== undefined) {
        process.env.VOYD_CONFORMANCE_ADAPTER = previousAdapter;
      } else {
        delete process.env.VOYD_CONFORMANCE_ADAPTER;
      }
      vi.doUnmock("@voyd-lang/sdk");
      vi.resetModules();
    }
  });
});
