import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createEffectsImports } from "./support/wasm-imports.js";
import { compileEffectFixture } from "./support/effects-harness.js";
import { wasmBufferSource } from "./support/wasm-utils.js";

const fixturePath = resolve(
  import.meta.dirname,
  "__fixtures__",
  "effects-generic-e2e.voyd"
);

const buildModule = () => compileEffectFixture({ entryPath: fixturePath });

describe("generic effects wasm e2e", () => {
  it("runs multiple instantiations of a generic effect", async () => {
    const { wasm } = await buildModule();
    const wasmModule = new WebAssembly.Module(wasmBufferSource(wasm));
    const instance = new WebAssembly.Instance(wasmModule, createEffectsImports());
    const test1 = instance.exports.test1 as CallableFunction;
    const test2 = instance.exports.test2 as CallableFunction;
    expect(test1()).toBe(20);
    expect(test2()).toBe(4.4);
  });
});
