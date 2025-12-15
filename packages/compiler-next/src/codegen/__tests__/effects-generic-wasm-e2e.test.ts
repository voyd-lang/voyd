import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "../../parser/index.js";
import { semanticsPipeline } from "../../semantics/pipeline.js";
import { codegen } from "../index.js";

const fixturePath = resolve(
  import.meta.dirname,
  "__fixtures__",
  "effects-generic-e2e.voyd"
);

const buildModule = () => {
  const source = readFileSync(fixturePath, "utf8");
  const semantics = semanticsPipeline(
    parse(source, "/proj/src/effects-generic-e2e.voyd")
  );
  return codegen(semantics);
};

describe("generic effects wasm e2e", () => {
  it("runs multiple instantiations of a generic effect", () => {
    const { module } = buildModule();
    const wasmBinary = new Uint8Array(module.emitBinary());
    const instance = new WebAssembly.Instance(
      new WebAssembly.Module(wasmBinary),
      {}
    );
    const test1 = instance.exports.test1 as CallableFunction;
    const test2 = instance.exports.test2 as CallableFunction;
    expect(test1()).toBe(20);
    expect(test2()).toBe(4);
  });
});

