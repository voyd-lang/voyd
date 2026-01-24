import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createEffectsImports } from "./support/wasm-imports.js";
import { compileEffectFixture } from "./support/effects-harness.js";

const fixturePath = resolve(
  import.meta.dirname,
  "__fixtures__",
  "effects-wasm-object-arg.voyd"
);

const buildModule = () => compileEffectFixture({ entryPath: fixturePath });

describe("effects wasm object args", () => {
  it("passes object arguments to in-wasm handlers", async () => {
    const { wasm } = await buildModule();
    const wasmBinary = wasm instanceof Uint8Array ? wasm : new Uint8Array(wasm);
    const instance = new WebAssembly.Instance(
      new WebAssembly.Module(wasmBinary),
      createEffectsImports()
    );
    const main = instance.exports.main as CallableFunction;
    expect(main()).toBe(42);
  });
});
