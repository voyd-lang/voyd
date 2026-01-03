import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { analyzeModules, emitProgram, loadModuleGraph } from "@voyd/compiler/pipeline.js";
import { assertRunnableWasm } from "../wasm-validation.js";

const require = createRequire(import.meta.url);

const resolveStdRoot = (): string =>
  dirname(require.resolve("@voyd/std/package.json"));

describe("wasm validation", () => {
  it("accepts wasm-gc modules that Node can validate", async () => {
    const entryPath = resolve(
      import.meta.dirname,
      "fixtures",
      "match_destructure_fields.voyd"
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
    expect(WebAssembly.validate(wasm)).toBe(true);

    (module as unknown as { validate: () => boolean }).validate = originalValidate;
  });
});

