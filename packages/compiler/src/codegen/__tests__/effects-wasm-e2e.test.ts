import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createEffectsImports } from "./support/wasm-imports.js";
import { compileEffectFixture } from "./support/effects-harness.js";

const fixturePath = resolve(
  import.meta.dirname,
  "__fixtures__",
  "effects-e2e.voyd"
);

const buildModule = () => compileEffectFixture({ entryPath: fixturePath });

describe("effects wasm e2e", () => {
  it("runs handlers inside wasm", async () => {
    const { wasm } = await buildModule();
    const wasmBinary = wasm instanceof Uint8Array ? wasm : new Uint8Array(wasm);
    const instance = new WebAssembly.Instance(
      new WebAssembly.Module(wasmBinary),
      createEffectsImports()
    );
    const main = instance.exports.main as CallableFunction;
    expect(main()).toBe(3);
  });

  it("traps on double resume", async () => {
    const { wasm } = await buildModule();
    const wasmBinary = wasm instanceof Uint8Array ? wasm : new Uint8Array(wasm);
    const instance = new WebAssembly.Instance(
      new WebAssembly.Module(wasmBinary),
      createEffectsImports()
    );
    const target = instance.exports.double_resume as CallableFunction;
    expect(() => target()).toThrow();
  });

  it("traps when a tail resume is missing", async () => {
    const { wasm } = await buildModule();
    const wasmBinary = wasm instanceof Uint8Array ? wasm : new Uint8Array(wasm);
    const instance = new WebAssembly.Instance(
      new WebAssembly.Module(wasmBinary),
      createEffectsImports()
    );
    const target = instance.exports.missing_tail as CallableFunction;
    expect(() => target()).toThrow();
  });

  it("supports direct performs inside a try body", async () => {
    const { wasm } = await buildModule();
    const wasmBinary = wasm instanceof Uint8Array ? wasm : new Uint8Array(wasm);
    const instance = new WebAssembly.Instance(
      new WebAssembly.Module(wasmBinary),
      createEffectsImports()
    );
    const target = instance.exports.perform_in_try as CallableFunction;
    expect(target()).toBe(15);
  });

  it("supports effects inside lambdas", async () => {
    const { wasm } = await buildModule();
    const wasmBinary = wasm instanceof Uint8Array ? wasm : new Uint8Array(wasm);
    const instance = new WebAssembly.Instance(
      new WebAssembly.Module(wasmBinary),
      createEffectsImports()
    );
    const target = instance.exports.lambda_perform as CallableFunction;
    expect(target()).toBe(25);
  });
});
