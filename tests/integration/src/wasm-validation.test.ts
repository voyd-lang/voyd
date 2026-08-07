import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveStdRoot } from "@voyd-lang/lib/resolve-std.js";
import { getWasmInstance } from "@voyd-lang/lib/wasm.js";
import {
  analyzeModules,
  emitProgram,
  loadModuleGraph,
} from "@voyd-lang/sdk/compiler";

type Diagnostic = {
  severity: string;
  code: string;
  message: string;
};

const fixturePath = (name: string): string =>
  fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

const findFirstError = (
  diagnostics: readonly Diagnostic[],
): Diagnostic | undefined =>
  diagnostics.find((diag) => diag.severity === "error");

const assertNoErrors = (diagnostics: readonly Diagnostic[]): void => {
  const error = findFirstError(diagnostics);
  if (!error) return;
  throw new Error(`${error.code}: ${error.message}`);
};

const compileToBinaryenModule = async (entryPath: string) => {
  const roots = { src: path.dirname(entryPath), std: resolveStdRoot() };
  const graph = await loadModuleGraph({ entryPath, roots });
  const { semantics, diagnostics } = analyzeModules({ graph });
  const allDiagnostics = [...graph.diagnostics, ...diagnostics] as Diagnostic[];
  assertNoErrors(allDiagnostics);
  const { module } = await emitProgram({
    graph,
    semantics,
  });
  return module;
};

type BinaryenLikeModule = {
  emitBinary: () => unknown;
  validate: () => unknown;
};

const emitWasmBytes = (mod: { emitBinary: () => unknown }): Uint8Array => {
  const emitted = mod.emitBinary();
  return emitted instanceof Uint8Array
    ? emitted
    : ((emitted as { binary?: Uint8Array; output?: Uint8Array }).output ??
        (emitted as { binary?: Uint8Array }).binary ??
        new Uint8Array());
};

const assertRunnableWasm = (mod: BinaryenLikeModule): Uint8Array => {
  const wasm = emitWasmBytes(mod);
  if (WebAssembly.validate(wasm as BufferSource)) {
    return wasm;
  }

  mod.validate();
  throw new Error("Module is invalid");
};

describe("integration: wasm validation", { timeout: 120_000 }, () => {
  it("supports generic enum macro expansion across modules", async () => {
    const module = await compileToBinaryenModule(
      fixturePath("enum-cross-module/main.voyd"),
    );
    const wasm = assertRunnableWasm(module);
    const instance = getWasmInstance(wasm);
    const exports = instance.exports as Record<string, unknown>;
    expect((exports.main as () => number)()).toBe(20);
  });

  it("supports generic enum inference regardless of variant order and generic unit variants", async () => {
    const module = await compileToBinaryenModule(
      fixturePath("enum-generic-variant-shapes.voyd"),
    );
    const wasm = assertRunnableWasm(module);
    const instance = getWasmInstance(wasm);
    const exports = instance.exports as Record<string, unknown>;
    expect((exports.main as () => number)()).toBe(11);
  });

  it("compiles std transcendental math without host math imports", async () => {
    const module = await compileToBinaryenModule(
      fixturePath("std-math-transcendentals.voyd"),
    );
    const wasm = assertRunnableWasm(module);
    const compiled = new WebAssembly.Module(wasm as BufferSource);
    const imports = WebAssembly.Module.imports(compiled).map(
      ({ module, name }) => `${module}::${name}`,
    );
    expect(imports.some((name) => name.startsWith("voyd_math::"))).toBe(false);

    const instance = new WebAssembly.Instance(compiled, { env: {} });
    const exports = instance.exports as Record<string, unknown>;
    expect((exports.main as () => number)()).toBe(1);
  });
});
