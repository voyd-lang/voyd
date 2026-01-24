import { describe, expect, it } from "vitest";
import { dirname, resolve } from "node:path";
import { resolveStdRoot } from "@voyd/lib/resolve-std.js";
import { getWasmInstance } from "@voyd/lib/wasm.js";
import {
  analyzeModules,
  emitProgram,
  loadModuleGraph,
} from "@voyd/sdk/compiler";
import { assertRunnableWasm } from "../wasm-validation.js";

describe(
  "wasm validation",
  () => {
    it("accepts wasm-gc modules that Node can validate", async () => {
      const entryPath = resolve(
        import.meta.dirname,
        "fixtures",
        "match_destructure_fields.voyd",
      );
      const roots = { src: dirname(entryPath), std: resolveStdRoot() };
      const graph = await loadModuleGraph({ entryPath, roots });
      const { semantics } = analyzeModules({ graph });
      const { module } = await emitProgram({ graph, semantics });

      const originalValidate = module.validate.bind(module);
      (module as unknown as { validate: () => boolean }).validate = () => {
        throw new Error("binaryen validate should not run when wasm validates");
      };

      const wasm = assertRunnableWasm(module);
      expect(wasm).toBeInstanceOf(Uint8Array);
      expect(WebAssembly.validate(wasm as BufferSource)).toBe(true);

      (module as unknown as { validate: () => number }).validate =
        originalValidate;
    });

    it("compiles std::optional and preserves optional semantics", async () => {
      const entryPath = resolve(
        import.meta.dirname,
        "fixtures",
        "std_optional_basic.voyd",
      );
      const roots = { src: dirname(entryPath), std: resolveStdRoot() };
      const graph = await loadModuleGraph({ entryPath, roots });
      const { semantics, diagnostics } = analyzeModules({ graph });
      const error = [...graph.diagnostics, ...diagnostics].find(
        (diag) => diag.severity === "error",
      );
      if (error) {
        throw new Error(`${error.code}: ${error.message}`);
      }
      const { module } = await emitProgram({ graph, semantics });
      const wasm = assertRunnableWasm(module);
      const instance = getWasmInstance(wasm);
      const exports = instance.exports as Record<string, unknown>;
      expect((exports.main as () => number)()).toBe(12);
    });
  },
  { timeout: 20_000 },
);
