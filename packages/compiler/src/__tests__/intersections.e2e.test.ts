import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { getWasmInstance } from "@voyd/lib/wasm.js";
import { createMemoryModuleHost } from "../modules/memory-host.js";
import { createNodePathAdapter } from "../modules/node-path-adapter.js";
import type { ModuleHost } from "../modules/types.js";
import { compileProgram } from "../pipeline.js";

const fixturesDir = resolve(import.meta.dirname, "__fixtures__");

const loadFixture = (name: string): string =>
  readFileSync(resolve(fixturesDir, name), "utf8");

const createFixtureHost = (files: Record<string, string>): ModuleHost =>
  createMemoryModuleHost({ files, pathAdapter: createNodePathAdapter() });

describe("intersections e2e", () => {
  it("supports nominal, structural, and trait intersections", async () => {
    const root = resolve("/proj/src");
    const mainPath = `${root}${sep}main.voyd`;
    const host = createFixtureHost({
      [mainPath]: loadFixture("intersection.voyd"),
    });

    const result = await compileProgram({
      entryPath: mainPath,
      roots: { src: root },
      host,
    });

    expect(result.diagnostics).toHaveLength(0);
    expect(result.wasm).toBeInstanceOf(Uint8Array);

    const instance = getWasmInstance(result.wasm!);
    const exports = instance.exports as Record<string, unknown>;
    const exportedFunctions = Object.entries(exports)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name)
      .sort();

    expect(exportedFunctions).toEqual([
      "test_nominal_intersections",
      "test_nominal_structural_trait_intersection",
      "test_structural_intersections",
      "test_structural_trait_intersection",
      "test_trait_intersections",
    ]);

    expect(
      (exports.test_nominal_structural_trait_intersection as () => number)(),
    ).toBe(20);
    expect((exports.test_nominal_intersections as () => number)()).toBe(25);
    expect((exports.test_structural_trait_intersection as () => number)()).toBe(
      608,
    );
    expect((exports.test_structural_intersections as () => number)()).toBe(6);
    expect((exports.test_trait_intersections as () => number)()).toBe(475);
  });
});
