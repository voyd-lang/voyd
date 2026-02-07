import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveStdRoot } from "@voyd/lib/resolve-std.js";
import { getWasmInstance } from "@voyd/lib/wasm.js";
import { createVoydHost } from "@voyd/js-host";
import {
  analyzeModules,
  emitProgram,
  loadModuleGraph,
} from "@voyd/sdk/compiler";

type Diagnostic = {
  severity: string;
  code: string;
  message: string;
};

const fixturePath = (name: string): string =>
  fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

const findFirstError = (diagnostics: readonly Diagnostic[]): Diagnostic | undefined =>
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
  const { module } = await emitProgram({ graph, semantics });
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
    : (emitted as { binary?: Uint8Array; output?: Uint8Array }).output ??
        (emitted as { binary?: Uint8Array }).binary ??
        new Uint8Array();
};

const assertRunnableWasm = (mod: BinaryenLikeModule): Uint8Array => {
  const wasm = emitWasmBytes(mod);
  if (WebAssembly.validate(wasm as BufferSource)) {
    return wasm;
  }

  mod.validate();
  throw new Error("Module is invalid");
};

const normalize = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(normalize);
  }
  if (value instanceof Map) {
    return Object.fromEntries(
      Array.from(value.entries()).map(([key, entry]) => [String(key), normalize(entry)]),
    );
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, normalize(entry)]),
    );
  }
  return value;
};

describe(
  "smoke: wasm validation",
  { timeout: 20_000 },
  () => {
    it("accepts wasm-gc modules that Node can validate", async () => {
      const module = await compileToBinaryenModule(
        fixturePath("match_destructure_fields.voyd"),
      );
      const mod = module as unknown as BinaryenLikeModule;

      const originalValidate = mod.validate.bind(module);
      mod.validate = () => {
        throw new Error("binaryen validate should not run when wasm validates");
      };

      const wasm = assertRunnableWasm(mod);
      expect(wasm).toBeInstanceOf(Uint8Array);
      expect(WebAssembly.validate(wasm as BufferSource)).toBe(true);

      mod.validate = originalValidate;
    });

    it("compiles std::optional and preserves optional semantics", async () => {
      const module = await compileToBinaryenModule(fixturePath("std_optional_basic.voyd"));
      const wasm = assertRunnableWasm(module);
      const instance = getWasmInstance(wasm);
      const exports = instance.exports as Record<string, unknown>;
      expect((exports.main as () => number)()).toBe(12);
    });

    it("supports module-qualified return type annotations", async () => {
      const module = await compileToBinaryenModule(fixturePath("sink.test.voyd"));
      const wasm = assertRunnableWasm(module);
      const instance = getWasmInstance(wasm);
      const exports = instance.exports as Record<string, unknown>;
      expect((exports.main as () => number)()).toBe(42);
    });

    it("compiles MsgPack recursive unions used by vx.voyd", async () => {
      const module = await compileToBinaryenModule(fixturePath("vx.voyd"));
      const wasm = assertRunnableWasm(module);
      expect(WebAssembly.validate(wasm as BufferSource)).toBe(true);

      const host = await createVoydHost({ wasm });
      const result = await host.runPure("main");

      const normalized = normalize(result) as Record<string, unknown>;
      expect(normalized).toEqual(expect.objectContaining({ name: "div" }));
      expect(normalized.attributes).toBeTypeOf("object");
      expect(normalized.children).toBeInstanceOf(Array);
    });
  }
);
