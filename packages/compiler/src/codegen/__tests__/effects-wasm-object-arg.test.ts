import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createEffectsImports } from "./support/wasm-imports.js";
import { compileEffectFixture } from "./support/effects-harness.js";
import { wasmBufferSource } from "./support/wasm-utils.js";

const fixturePath = resolve(
  import.meta.dirname,
  "__fixtures__",
  "effects-wasm-object-arg.voyd"
);

const buildModule = () => compileEffectFixture({ entryPath: fixturePath });

describe("effects wasm object args", () => {
  it("passes object arguments to in-wasm handlers", async () => {
    const { wasm } = await buildModule();
    const wasmModule = new WebAssembly.Module(wasmBufferSource(wasm));
    const instance = new WebAssembly.Instance(wasmModule, createEffectsImports());
    const main = instance.exports.main as CallableFunction;
    expect(main()).toBe(42);
  });
});
