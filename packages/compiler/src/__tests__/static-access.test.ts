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
  expect(result.success).toBe(true);
  if (!result.success) {
    throw new Error(JSON.stringify(result.diagnostics, null, 2));
  }
  return result;
};

describe("static access e2e", () => {
  it("instantiates static methods using target type arguments", async () => {
    const root = resolve("/proj/src");
    const mainPath = `${root}${sep}main.voyd`;
    const host = createFixtureHost({
      [mainPath]: loadFixture("static_method_generic.voyd"),
    });

    const result = expectCompileSuccess(await compileProgram({
      entryPath: mainPath,
      roots: { src: root },
      host,
    }));
    expect(result.wasm).toBeInstanceOf(Uint8Array);

    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(11);
  });

  it("calls module-qualified functions without importing into scope", async () => {
    const root = resolve("/proj/src");
    const mainPath = `${root}${sep}main.voyd`;
    const utilPath = `${root}${sep}util.voyd`;
    const host = createFixtureHost({
      [mainPath]: loadFixture("module_access_main.voyd"),
      [utilPath]: loadFixture("module_access_util.voyd"),
    });

    const result = expectCompileSuccess(await compileProgram({
      entryPath: mainPath,
      roots: { src: root },
      host,
    }));
    expect(result.wasm).toBeInstanceOf(Uint8Array);

    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(41);
  });

  it("invokes static methods on imported types", async () => {
    const root = resolve("/proj/src");
    const mainPath = `${root}${sep}main.voyd`;
    const utilPath = `${root}${sep}util.voyd`;
    const host = createFixtureHost({
      [mainPath]: loadFixture("static_method_import_main.voyd"),
      [utilPath]: loadFixture("static_method_import_util.voyd"),
    });

    const result = expectCompileSuccess(await compileProgram({
      entryPath: mainPath,
      roots: { src: root },
      host,
    }));
    expect(result.wasm).toBeInstanceOf(Uint8Array);

    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(41);
  });

  it("resolves overloaded imports pulled directly into scope", async () => {
    const root = resolve("/proj/src");
    const mainPath = `${root}${sep}main.voyd`;
    const modPath = `${root}${sep}overload_mod.voyd`;
    const host = createFixtureHost({
      [mainPath]: loadFixture("overload_use_direct.voyd"),
      [modPath]: loadFixture("overload_mod.voyd"),
    });

    const result = expectCompileSuccess(await compileProgram({
      entryPath: mainPath,
      roots: { src: root },
      host,
    }));
    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(5);
  });

  it("resolves overloaded module-qualified calls", async () => {
    const root = resolve("/proj/src");
    const mainPath = `${root}${sep}main.voyd`;
    const modPath = `${root}${sep}overload_mod.voyd`;
    const host = createFixtureHost({
      [mainPath]: loadFixture("overload_use_module.voyd"),
      [modPath]: loadFixture("overload_mod.voyd"),
    });

    const result = expectCompileSuccess(await compileProgram({
      entryPath: mainPath,
      roots: { src: root },
      host,
    }));
    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(5);
  });

  it("falls back from expected-return overload narrowing when argument matching succeeds", async () => {
    const root = resolve("/proj/src");
    const mainPath = `${root}${sep}main.voyd`;
    const vec3Path = `${root}${sep}vec3.voyd`;
    const rayPath = `${root}${sep}ray.voyd`;
    const mathxPath = `${root}${sep}mathx.voyd`;
    const host = createFixtureHost({
      [mainPath]: loadFixture("overload_expected_return_hint_main.voyd"),
      [vec3Path]: loadFixture("overload_expected_return_hint_vec3.voyd"),
      [rayPath]: loadFixture("overload_expected_return_hint_ray.voyd"),
      [mathxPath]: loadFixture("overload_expected_return_hint_mathx.voyd"),
    });

    const result = expectCompileSuccess(await compileProgram({
      entryPath: mainPath,
      roots: { src: root },
      host,
    }));
    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(1);
  });

  it("keeps codegen call argument planning aligned with typing labels", async () => {
    const root = resolve("/proj/src");
    const mainPath = `${root}${sep}main.voyd`;
    const host = createFixtureHost({
      [mainPath]: loadFixture("call_label_optional_alignment.voyd"),
    });

    const result = expectCompileSuccess(await compileProgram({
      entryPath: mainPath,
      roots: { src: root },
      host,
    }));
    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(7);
  });

  it("runs curried closure calls with optional arguments", async () => {
    const root = resolve("/proj/src");
    const mainPath = `${root}${sep}main.voyd`;
    const host = createFixtureHost({
      [mainPath]: loadFixture("closure_curried_optional_call.voyd"),
    });

    const result = expectCompileSuccess(await compileProgram({
      entryPath: mainPath,
      roots: { src: root },
      host,
    }));
    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(15);
  });

  it("handles callback closures that capture mutable state and use labeled calls", async () => {
    const root = resolve("/proj/src");
    const mainPath = `${root}${sep}main.voyd`;
    const host = createFixtureHost({
      [mainPath]: loadFixture("closure_callback_capture_labeled_calls.voyd"),
    });

    const result = expectCompileSuccess(await compileProgram({
      entryPath: mainPath,
      roots: { src: root },
      host,
    }));
    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(6);
  });

  it("resumes curried closure calls after effectful argument sites", async () => {
    const root = resolve("/proj/src");
    const mainPath = `${root}${sep}main.voyd`;
    const host = createFixtureHost({
      [mainPath]: loadFixture("closure_curried_effect_resume.voyd"),
    });

    const result = expectCompileSuccess(await compileProgram({
      entryPath: mainPath,
      roots: { src: root },
      host,
    }));
    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(20);
  });
});
