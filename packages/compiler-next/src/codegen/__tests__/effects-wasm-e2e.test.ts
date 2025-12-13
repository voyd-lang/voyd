import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "../../parser/index.js";
import { semanticsPipeline } from "../../semantics/pipeline.js";
import { codegen } from "../index.js";

const fixturePath = resolve(
  import.meta.dirname,
  "__fixtures__",
  "effects-e2e.voyd"
);

const buildModule = () => {
  const source = readFileSync(fixturePath, "utf8");
  const semantics = semanticsPipeline(
    parse(source, "/proj/src/effects-e2e.voyd")
  );
  return codegen(semantics);
};

describe("effects wasm e2e", () => {
  it("runs handlers inside wasm", () => {
    const { module } = buildModule();
    const wasmBinary = new Uint8Array(module.emitBinary());
    const instance = new WebAssembly.Instance(
      new WebAssembly.Module(wasmBinary),
      {}
    );
    const main = instance.exports.main as CallableFunction;
    expect(main()).toBe(3);
  });

  it("traps on double resume", () => {
    const { module } = buildModule();
    const wasmBinary = new Uint8Array(module.emitBinary());
    const instance = new WebAssembly.Instance(
      new WebAssembly.Module(wasmBinary),
      {}
    );
    const target = instance.exports.double_resume as CallableFunction;
    expect(() => target()).toThrow();
  });

  it("traps when a tail resume is missing", () => {
    const { module } = buildModule();
    const wasmBinary = new Uint8Array(module.emitBinary());
    const instance = new WebAssembly.Instance(
      new WebAssembly.Module(wasmBinary),
      {}
    );
    const target = instance.exports.missing_tail as CallableFunction;
    expect(() => target()).toThrow();
  });

  it("supports direct performs inside a try body", () => {
    const { module } = buildModule();
    const wasmBinary = new Uint8Array(module.emitBinary());
    const instance = new WebAssembly.Instance(
      new WebAssembly.Module(wasmBinary),
      {}
    );
    const target = instance.exports.perform_in_try as CallableFunction;
    expect(target()).toBe(15);
  });
});
