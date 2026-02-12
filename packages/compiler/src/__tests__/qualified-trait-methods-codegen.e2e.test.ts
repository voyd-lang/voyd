import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { getWasmInstance } from "@voyd/lib/wasm.js";
import { createMemoryModuleHost } from "../modules/memory-host.js";
import { createNodePathAdapter } from "../modules/node-path-adapter.js";
import type { ModuleHost } from "../modules/types.js";
import { compileProgram, type CompileProgramResult } from "../pipeline.js";

const fixturesDir = resolve(import.meta.dirname, "__fixtures__");

const loadFixture = (name: string): string =>
  readFileSync(resolve(fixturesDir, name), "utf8");

const createFixtureHost = (files: Record<string, string>): ModuleHost =>
  createMemoryModuleHost({ files, pathAdapter: createNodePathAdapter() });

const expectCompileSuccess = (
  result: CompileProgramResult,
): Extract<CompileProgramResult, { success: true }> => {
  if (!result.success) {
    throw new Error(JSON.stringify(result.diagnostics, null, 2));
  }
  expect(result.success).toBe(true);
  return result;
};

describe("qualified trait methods codegen e2e", () => {
  it("supports `.Trait::method()` to disambiguate conflicting trait methods", async () => {
    const root = resolve("/proj/src");
    const mainPath = `${root}${sep}main.voyd`;
    const host = createFixtureHost({
      [mainPath]: loadFixture("qualified_trait_methods_conflict.voyd"),
    });

    const result = expectCompileSuccess(await compileProgram({
      entryPath: mainPath,
      roots: { src: root },
      host,
    }));
    expect(result.wasm).toBeInstanceOf(Uint8Array);

    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(50);
  });

  it("supports `.Trait::method()` when the receiver is a trait intersection", async () => {
    const root = resolve("/proj/src");
    const mainPath = `${root}${sep}main.voyd`;
    const host = createFixtureHost({
      [mainPath]: loadFixture("qualified_trait_methods_intersection_conflict.voyd"),
    });

    const result = expectCompileSuccess(await compileProgram({
      entryPath: mainPath,
      roots: { src: root },
      host,
    }));
    expect(result.wasm).toBeInstanceOf(Uint8Array);

    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(50);
  });

  it("supports qualified trait calls when same-name overloads include non-self and self variants", async () => {
    const root = resolve("/proj/src");
    const mainPath = `${root}${sep}main.voyd`;
    const host = createFixtureHost({
      [mainPath]: loadFixture("qualified_trait_methods_overload_receiver.voyd"),
    });

    const result = expectCompileSuccess(await compileProgram({
      entryPath: mainPath,
      roots: { src: root },
      host,
    }));
    expect(result.wasm).toBeInstanceOf(Uint8Array);

    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(85);
  });
});
