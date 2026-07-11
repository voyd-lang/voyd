import { describe, expect, it } from "vitest";
import { normalizeRuntimeTrap } from "./current-compiler-adapter.js";
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

  it("normalizes only genuine WebAssembly runtime traps", () => {
    expect(normalizeRuntimeTrap(new WebAssembly.RuntimeError("boom"))).toEqual({
      name: "RuntimeError",
      message: "boom",
    });
    expect(() => normalizeRuntimeTrap(new Error("adapter failure"))).toThrow(
      "adapter failure",
    );
  });
});
