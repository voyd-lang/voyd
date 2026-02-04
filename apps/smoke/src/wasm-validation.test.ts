import path from "node:path";
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
  path.join(process.cwd(), "fixtures", name);

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

const emitWasmBytes = (mod: { emitBinary: () => unknown }): Uint8Array => {
  const emitted = mod.emitBinary();
  return emitted instanceof Uint8Array
    ? emitted
    : (emitted as { binary?: Uint8Array; output?: Uint8Array }).output ??
        (emitted as { binary?: Uint8Array }).binary ??
        new Uint8Array();
};

const assertRunnableWasm = (mod: {
  emitBinary: () => unknown;
  validate: () => boolean;
}): Uint8Array => {
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
  () => {
    it("accepts wasm-gc modules that Node can validate", async () => {
      const module = await compileToBinaryenModule(
        fixturePath("match_destructure_fields.voyd"),
      );

      const originalValidate = module.validate.bind(module);
      (module as unknown as { validate: () => boolean }).validate = () => {
        throw new Error("binaryen validate should not run when wasm validates");
      };

      const wasm = assertRunnableWasm(module);
      expect(wasm).toBeInstanceOf(Uint8Array);
      expect(WebAssembly.validate(wasm as BufferSource)).toBe(true);

      (module as unknown as { validate: () => boolean }).validate = originalValidate;
    });

    it("compiles std::optional and preserves optional semantics", async () => {
      const module = await compileToBinaryenModule(fixturePath("std_optional_basic.voyd"));
      const wasm = assertRunnableWasm(module);
      const instance = getWasmInstance(wasm);
      const exports = instance.exports as Record<string, unknown>;
      expect((exports.main as () => number)()).toBe(12);
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
  },
  { timeout: 20_000 },
);

