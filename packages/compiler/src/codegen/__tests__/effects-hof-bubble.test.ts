import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "../../parser/index.js";
import { semanticsPipeline } from "../../semantics/pipeline.js";
import { codegen } from "../index.js";
import { createEffectsImports } from "./support/wasm-imports.js";
import { runEffectfulExport, parseEffectTable } from "./support/effects-harness.js";

const fixturePath = resolve(
  import.meta.dirname,
  "__fixtures__",
  "effects-hof-bubble.voyd"
);

const buildModule = () => {
  const source = readFileSync(fixturePath, "utf8");
  const semantics = semanticsPipeline(
    parse(source, "/proj/src/effects-hof-bubble.voyd")
  );
  return codegen(semantics);
};

describe("effects higher-order functions", () => {
  it("bubbles lambda effects through effect-polymorphic callers", async () => {
    const { module } = buildModule();
    const parsed = parseEffectTable(module);
    const awaitOp = parsed.ops.find((op) => op.label.endsWith("Async.await"));
    if (!awaitOp) {
      throw new Error("missing Async.await op entry");
    }

    const seen: any[] = [];
    const result = await runEffectfulExport<number>({
      wasm: module,
      entryName: "bubble_effectful",
      handlers: {
        [`${awaitOp.opIndex}`]: (request) => {
          seen.push(request);
          return 12;
        },
      },
    });
    expect(result.value).toBe(19);
    expect(seen.length).toBe(1);
  });

  it("resumes into lambdas with captured variables", () => {
    const { module } = buildModule();
    const wasmBinary = new Uint8Array(module.emitBinary());
    const instance = new WebAssembly.Instance(
      new WebAssembly.Module(wasmBinary),
      createEffectsImports()
    );
    const handled = instance.exports.handled as CallableFunction;
    expect(handled()).toBe(15);
  });
});
