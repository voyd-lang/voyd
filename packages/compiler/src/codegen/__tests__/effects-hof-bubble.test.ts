import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createEffectsImports } from "./support/wasm-imports.js";
import {
  compileEffectFixture,
  runEffectfulExport,
  parseEffectTable,
} from "./support/effects-harness.js";

const fixturePath = resolve(
  import.meta.dirname,
  "__fixtures__",
  "effects-hof-bubble.voyd"
);

const buildModule = () => compileEffectFixture({ entryPath: fixturePath });

describe("effects higher-order functions", () => {
  it("bubbles lambda effects through effect-polymorphic callers", async () => {
    const { module } = await buildModule();
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

  it("resumes into lambdas with captured variables", async () => {
    const { wasm } = await buildModule();
    const wasmBinary = wasm instanceof Uint8Array ? wasm : new Uint8Array(wasm);
    const instance = new WebAssembly.Instance(
      new WebAssembly.Module(wasmBinary),
      createEffectsImports()
    );
    const handled = instance.exports.handled as CallableFunction;
    expect(handled()).toBe(15);
  });
});
